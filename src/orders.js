import { ObjectId } from "mongodb";
import { randomBytes, randomUUID } from "node:crypto";
import { transaction } from "./db.js";
import { config, walletsEnabled } from "./config.js";
import {
  calculateTotals,
  normalizeItems,
  fingerprint,
  HttpError,
  assertPayment,
} from "./domain.js";
export function orderService({ db, client, gateway }) {
  const orders = db.collection("orders");
  async function checkout(user, input) {
    const items = normalizeItems(input.items);
    const fp = fingerprint({
      items,
      shipping: input.shipping,
      method: input.paymentMethod,
      fromCart: input.fromCart,
      expectedTotalPaisa: input.expectedTotalPaisa,
    });
    const previous = await orders.findOne({
      userId: user._id,
      idempotencyKey: input.idempotencyKey,
    });
    if (previous) {
      if (previous.fingerprint !== fp)
        throw new HttpError(
          409,
          "This checkout was already submitted with different details. Reload checkout.",
        );
      return previous;
    }
    if (input.paymentMethod !== "cod" && !walletsEnabled())
      throw new HttpError(
        503,
        "Online payments are unavailable. Select cash on delivery.",
      );
    let order;
    try {
      order = await transaction(client, async (session) => {
        const existing = await orders.findOne(
          { userId: user._id, idempotencyKey: input.idempotencyKey },
          { session },
        );
        if (existing) {
          if (existing.fingerprint !== fp)
            throw new HttpError(409, "Checkout details have changed.");
          return existing;
        }
        const products = await db
          .collection("products")
          .find(
            { _id: { $in: items.map((x) => new ObjectId(x.productId)) } },
            { session },
          )
          .toArray();
        const totals = calculateTotals(products, items, input.shipping, config);
        if (totals.totalPaisa !== input.expectedTotalPaisa)
          throw new HttpError(
            409,
            "Prices or shipping changed. Reload checkout and confirm the updated total.",
          );
        const now = new Date();
        for (const item of totals.items) {
          const updated = await db
            .collection("products")
            .updateOne(
              {
                _id: item.productId,
                active: true,
                stock: { $gte: item.quantity },
              },
              { $inc: { stock: -item.quantity }, $set: { updatedAt: now } },
              { session },
            );
          if (!updated.modifiedCount)
            throw new HttpError(409, "Stock changed. Please refresh your bag.");
        }
        const record = {
          _id: new ObjectId(),
          userId: user._id,
          customerName: user.name,
          customerEmail: user.email,
          ...totals,
          shipping: input.shipping,
          paymentMethod: input.paymentMethod,
          paymentStatus: input.paymentMethod === "cod" ? "unpaid" : "pending",
          status:
            input.paymentMethod === "cod" ? "pending" : "awaiting_payment",
          idempotencyKey: input.idempotencyKey,
          fingerprint: fp,
          stockHeld: true,
          transactionId: `AV${randomUUID().replaceAll("-", "").slice(0, 26)}`,
          callbackToken: randomBytes(24).toString("hex"),
          expiresAt:
            input.paymentMethod === "cod"
              ? null
              : new Date(now.getTime() + 30 * 60000),
          createdAt: now,
          updatedAt: now,
        };
        await orders.insertOne(record, { session });
        // Remove only purchased quantities; keep other cart items.
        if (input.fromCart) {
          const cart = await db
            .collection("carts")
            .findOne({ userId: user._id }, { session });
          if (cart) {
            const remaining = cart.items
              .map((x) => ({
                ...x,
                quantity:
                  x.quantity -
                  (items.find((i) => i.productId === x.productId)?.quantity ||
                    0),
              }))
              .filter((x) => x.quantity > 0);
            await db
              .collection("carts")
              .updateOne(
                { _id: cart._id },
                { $set: { items: remaining, updatedAt: now } },
                { session },
              );
          }
        }
        return record;
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await orders.findOne({
        userId: user._id,
        idempotencyKey: input.idempotencyKey,
      });
      if (!existing || existing.fingerprint !== fp)
        throw new HttpError(409, "Duplicate checkout. Reload to continue.");
      return existing;
    }
    return order;
  }
  async function paymentLink(user, orderId) {
    const order = await orders.findOne({ _id: orderId, userId: user._id });
    if (!order) throw new HttpError(404, "Order not found.");
    if (order.paymentMethod === "cod" || order.paymentStatus === "paid")
      throw new HttpError(409, "This order does not require online payment.");
    if (order.status !== "awaiting_payment" || order.expiresAt <= new Date())
      throw new HttpError(
        409,
        "This payment reservation expired. Please create a new order.",
      );
    if (order.gatewayUrl) return { url: order.gatewayUrl };
    // An atomic short lease prevents concurrent initiation and duplicate gateway sessions.
    const locked = await orders.findOneAndUpdate(
      {
        _id: orderId,
        gatewayUrl: { $exists: false },
        $or: [
          { gatewayLock: { $exists: false } },
          { gatewayLock: { $lt: new Date(Date.now() - 60000) } },
        ],
      },
      { $set: { gatewayLock: new Date() } },
      { returnDocument: "after" },
    );
    if (!locked)
      throw new HttpError(
        409,
        "Payment checkout is being prepared. Try again in a moment.",
      );
    try {
      const payment = await gateway.create(order, user);
      await orders.updateOne(
        { _id: orderId, status: "awaiting_payment" },
        {
          $set: {
            gatewayUrl: payment.url,
            gatewaySessionKey: payment.sessionKey,
          },
          $unset: { gatewayLock: "" },
        },
      );
      return { url: payment.url };
    } catch (error) {
      await orders.updateOne({ _id: orderId }, { $unset: { gatewayLock: "" } });
      throw error;
    }
  }
  async function release(orderId, status = "expired", userId) {
    return transaction(client, async (session) => {
      const order = await orders.findOne(
        { _id: orderId, ...(userId ? { userId } : {}) },
        { session },
      );
      if (!order) throw new HttpError(404, "Order not found.");
      if (["paid", "review"].includes(order.paymentStatus))
        throw new HttpError(
          409,
          "Paid orders require merchant refund handling before cancellation.",
        );
      if (["cancelled", "expired"].includes(order.status)) return order;
      if (!["pending", "awaiting_payment", "processing"].includes(order.status))
        throw new HttpError(409, "This order can no longer be cancelled.");
      if (userId && !["pending", "awaiting_payment"].includes(order.status))
        throw new HttpError(409, "This order is already being prepared.");
      if (
        status === "expired" &&
        (!order.expiresAt ||
          order.expiresAt > new Date() ||
          order.status !== "awaiting_payment")
      )
        return order;
      if (order.stockHeld)
        for (const item of order.items) {
          await db
            .collection("products")
            .updateOne(
              { _id: item.productId },
              {
                $inc: { stock: item.quantity },
                $set: { updatedAt: new Date() },
              },
              { session },
            );
        }
      await orders.updateOne(
        { _id: orderId },
        {
          $set: {
            status,
            stockHeld: false,
            paymentStatus: order.paymentMethod === "cod" ? "unpaid" : "failed",
            updatedAt: new Date(),
          },
        },
        { session },
      );
      return { ...order, status };
    });
  }
  async function settle(validationId) {
    const result = await gateway.validate(validationId);
    const found = await orders.findOne({ transactionId: result.tran_id });
    if (!found || found.paymentMethod === "cod")
      throw new HttpError(404, "Payment order not found.");
    const { needsReview } = assertPayment(found, result);
    return transaction(client, async (session) => {
      const order = await orders.findOne({ _id: found._id }, { session });
      if (["paid", "review"].includes(order.paymentStatus)) {
        if (order.validationId !== result.val_id)
          throw new HttpError(
            409,
            "This order already has a different payment. Contact the merchant.",
          );
        return order;
      }
      let stockHeld = order.stockHeld;
      let review = needsReview || order.status === "cancelled";
      // A delayed valid IPN after expiry must never silently oversell stock.
      if (!stockHeld && !review) {
        const inventory = await db
          .collection("products")
          .find(
            { _id: { $in: order.items.map((x) => x.productId) } },
            { session },
          )
          .toArray();
        const available = order.items.every((x) =>
          inventory.some(
            (p) =>
              p._id.equals(x.productId) && p.active && p.stock >= x.quantity,
          ),
        );
        if (available) {
          for (const item of order.items)
            await db
              .collection("products")
              .updateOne(
                { _id: item.productId },
                {
                  $inc: { stock: -item.quantity },
                  $set: { updatedAt: new Date() },
                },
                { session },
              );
          stockHeld = true;
        } else review = true;
      }
      const changes = {
        stockHeld,
        status: review ? "payment_review" : "pending",
        paymentStatus: review ? "review" : "paid",
        validationId: result.val_id,
        bankTransactionId: result.bank_tran_id || "",
        verifiedGateway: result.bank_gw || result.card_type || "",
        paidAt: new Date(),
        updatedAt: new Date(),
        reviewReason: review
          ? "Verify payment risk/channel, cancellation, or inventory with the payment provider before fulfillment/refund."
          : null,
      };
      await orders.updateOne(
        { _id: order._id },
        { $set: changes },
        { session },
      );
      return { ...order, ...changes };
    });
  }
  async function changeStatus(orderId, next) {
    if (next === "cancelled") return release(orderId, next);
    return transaction(client, async (session) => {
      const order = await orders.findOne({ _id: orderId }, { session });
      if (!order) throw new HttpError(404, "Order not found.");
      const transitions = {
        pending: ["processing"],
        processing: ["shipped"],
        shipped: ["delivered"],
      };
      if (!transitions[order.status]?.includes(next))
        throw new HttpError(409, "Invalid order status transition.");
      if (order.paymentMethod !== "cod" && order.paymentStatus !== "paid")
        throw new HttpError(409, "Verify online payment before fulfillment.");
      const changes = { status: next, updatedAt: new Date() };
      if (next === "delivered") {
        changes.deliveredAt = new Date();
        if (order.paymentMethod === "cod")
          Object.assign(changes, { paymentStatus: "paid", paidAt: new Date() });
      }
      await orders.updateOne({ _id: orderId }, { $set: changes }, { session });
      return { ...order, ...changes };
    });
  }
  async function expire() {
    const stale = await orders
      .find({ status: "awaiting_payment", expiresAt: { $lte: new Date() } })
      .project({ _id: 1 })
      .limit(100)
      .toArray();
    for (const order of stale) {
      try {
        await release(order._id);
      } catch (e) {
        if (e.status !== 409) throw e;
      }
    }
  }
  return { checkout, paymentLink, release, settle, changeStatus, expire };
}
