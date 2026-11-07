import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { toNodeHandler } from "better-auth/node";
import { z, ZodError } from "zod";
import { config, walletsEnabled } from "./config.js";
import { createAuth, authentication, admin, safeUser } from "./auth.js";
import {
  HttpError,
  oid,
  categories,
  productSchema,
  checkoutSchema,
  publicProduct,
  publicOrder,
  moneyToPaisa,
} from "./domain.js";
import { transaction } from "./db.js";
import { orderService } from "./orders.js";
import { paymentGateway } from "./payments.js";

const pagination = (query) => ({
  page: z.coerce.number().int().min(1).max(10000).default(1).parse(query.page),
  limit: z.coerce.number().int().min(1).max(50).default(12).parse(query.limit),
});
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const textQuery = (value) => z.string().trim().max(100).parse(value);
export function createApp({
  db,
  client,
  gateway = paymentGateway,
  skipRateLimit = false,
  authInstance,
}) {
  const app = express();
  const betterAuthInstance =
    authInstance || createAuth({ db, client, rateLimit: !skipRateLimit });
  const auth = authentication(db, betterAuthInstance);
  const service = orderService({ db, client, gateway });
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const providerCallback =
      /^\/payments\/ssl\/(ipn|success|fail|cancel)$/.test(req.path);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !providerCallback &&
      req.get("origin") !== config.clientOrigin
    ) {
      throw new HttpError(403, "Request origin is not allowed.");
    }
    next();
  });
  if (!skipRateLimit)
    app.use(
      "/api",
      rateLimit({
        windowMs: 60000,
        limit: 180,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skip: (req) => req.path.startsWith("/payments/ssl/"),
      }),
    );
  if (!skipRateLimit) {
    app.use(
      ["/api/auth/sign-in", "/api/auth/sign-up"],
      rateLimit({
        windowMs: 15 * 60000,
        limit: 20,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { message: "Too many attempts. Try again in 15 minutes." },
      }),
    );
  }
  // Better Auth must receive the request stream before any body parser.
  app.all(
    "/api/auth/{*path}",
    (req, res, next) => {
      // Overwrite caller-supplied values. Express resolves IP using TRUST_PROXY.
      req.headers["x-avarika-client-ip"] = req.ip || req.socket.remoteAddress;
      next();
    },
    toNodeHandler(betterAuthInstance),
  );
  app.use(
    express.json({ limit: "100kb" }),
    express.urlencoded({ extended: false, limit: "20kb" }),
  );
  app.get("/api/health", async (req, res) => {
    await db.command({ ping: 1 });
    res.json({ ok: true });
  });
  app.get("/api/store", (req, res) =>
    res.json({
      categories,
      dhaka: config.dhaka,
      outside: config.outside,
      freeShipping: config.freeShipping,
      email: config.storeEmail,
      payments: {
        cod: true,
        bkash: walletsEnabled(),
        nagad: walletsEnabled(),
        sandbox: !config.sslLive,
      },
    }),
  );

  function productQuery(query, isAdmin = false) {
    const filter = isAdmin ? {} : { active: true };
    if (query.search)
      filter.name = {
        $regex: escapeRegex(textQuery(query.search)),
        $options: "i",
      };
    if (query.category)
      filter.category = z.enum(categories).parse(query.category);
    if (query.featured === "true") filter.featured = true;
    if (query.inStock === "true") filter.stock = { $gt: 0 };
    if (query.minPrice || query.maxPrice) {
      filter.pricePaisa = {};
      if (query.minPrice)
        filter.pricePaisa.$gte = moneyToPaisa(
          z.coerce.number().min(0).max(1000000).parse(query.minPrice),
        );
      if (query.maxPrice)
        filter.pricePaisa.$lte = moneyToPaisa(
          z.coerce.number().min(0).max(1000000).parse(query.maxPrice),
        );
    }
    return filter;
  }
  async function listProducts(req, res, isAdmin = false) {
    const { page, limit } = pagination(req.query);
    const filter = productQuery(req.query, isAdmin);
    const sorts = {
      newest: { createdAt: -1 },
      "price-asc": { pricePaisa: 1 },
      "price-desc": { pricePaisa: -1 },
      name: { name: 1 },
    };
    const sort = sorts[req.query.sort] || sorts.newest;
    const [products, total] = await Promise.all([
      db
        .collection("products")
        .find(filter)
        .sort({ ...sort, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      db.collection("products").countDocuments(filter),
    ]);
    res.json({
      products: isAdmin ? products : products.map(publicProduct),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  }
  app.get("/api/products", (req, res) => listProducts(req, res));
  app.get("/api/products/:id", async (req, res) => {
    const product = await db
      .collection("products")
      .findOne({ _id: oid(req.params.id), active: true });
    if (!product) throw new HttpError(404, "Product not found.");
    const reviews = await db
      .collection("reviews")
      .find({ productId: product._id })
      .sort({ updatedAt: -1 })
      .limit(30)
      .project({ userId: 0 })
      .toArray();
    const [summary] = await db
      .collection("reviews")
      .aggregate([
        { $match: { productId: product._id } },
        {
          $group: {
            _id: null,
            rating: { $avg: "$rating" },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();
    res.json({
      product: publicProduct(product),
      reviews,
      rating: summary?.rating || 0,
      reviewCount: summary?.count || 0,
    });
  });

  app.get("/api/cart", auth, async (req, res) => {
    const cart = await db.collection("carts").findOne({ userId: req.user._id });
    const items = cart?.items || [];
    const products = await db
      .collection("products")
      .find({ _id: { $in: items.map((x) => oid(x.productId)) } })
      .toArray();
    res.json({
      items: items.map((item) => ({
        ...item,
        product: products.find((x) => x._id.toString() === item.productId)
          ? publicProduct(
              products.find((x) => x._id.toString() === item.productId),
            )
          : null,
      })),
    });
  });
  app.put("/api/cart/:id", auth, async (req, res) => {
    const productId = oid(req.params.id);
    const { quantity, mode } = z
      .object({
        quantity: z.number().int().min(0).max(20),
        mode: z.enum(["set", "add"]).default("set"),
      })
      .parse(req.body);
    await transaction(client, async (session) => {
      const cart = await db
        .collection("carts")
        .findOne({ userId: req.user._id }, { session });
      const items = cart?.items || [];
      const existing = items.find((x) => x.productId === req.params.id);
      const nextQty =
        mode === "add" ? (existing?.quantity || 0) + quantity : quantity;
      if (nextQty > 20) throw new HttpError(400, "Maximum 20 of each item.");
      if (nextQty > 0) {
        const product = await db
          .collection("products")
          .findOne({ _id: productId, active: true }, { session });
        if (!product || nextQty > product.stock)
          throw new HttpError(409, "Requested quantity is unavailable.");
      }
      const nextItems = items.filter((x) => x.productId !== req.params.id);
      if (nextQty)
        nextItems.push({ productId: req.params.id, quantity: nextQty });
      if (nextItems.length > 50)
        throw new HttpError(
          400,
          "Your bag can hold at most 50 different products.",
        );
      await db
        .collection("carts")
        .updateOne(
          { userId: req.user._id },
          { $set: { items: nextItems, updatedAt: new Date() } },
          { upsert: true, session },
        );
    });
    res.json({ ok: true });
  });

  app.post("/api/orders", auth, async (req, res) =>
    res.status(201).json({
      order: publicOrder(
        await service.checkout(req.user, checkoutSchema.parse(req.body)),
      ),
    }),
  );
  app.get("/api/orders", auth, async (req, res) => {
    const { page, limit } = pagination(req.query);
    const filter = { userId: req.user._id };
    const [orders, total] = await Promise.all([
      db
        .collection("orders")
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      db.collection("orders").countDocuments(filter),
    ]);
    res.json({
      orders: orders.map(publicOrder),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  });
  app.get("/api/orders/:id", auth, async (req, res) => {
    const order = await db
      .collection("orders")
      .findOne({ _id: oid(req.params.id), userId: req.user._id });
    if (!order) throw new HttpError(404, "Order not found.");
    res.json({ order: publicOrder(order) });
  });
  app.post("/api/orders/:id/payment", auth, async (req, res) =>
    res.json(await service.paymentLink(req.user, oid(req.params.id))),
  );
  app.post("/api/orders/:id/cancel", auth, async (req, res) => {
    await service.release(oid(req.params.id), "cancelled", req.user._id);
    res.json({ ok: true });
  });
  app.get("/api/me/overview", auth, async (req, res) => {
    const [stats] = await db
      .collection("orders")
      .aggregate([
        { $match: { userId: req.user._id } },
        {
          $group: {
            _id: null,
            orders: { $sum: 1 },
            delivered: {
              $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] },
            },
            spentPaisa: {
              $sum: {
                $cond: [{ $eq: ["$paymentStatus", "paid"] }, "$totalPaisa", 0],
              },
            },
          },
        },
      ])
      .toArray();
    res.json({ stats: stats || { orders: 0, delivered: 0, spentPaisa: 0 } });
  });
  app.get("/api/me/reviews", auth, async (req, res) => {
    const delivered = await db
      .collection("orders")
      .find({ userId: req.user._id, status: "delivered" })
      .project({ items: 1 })
      .toArray();
    const unique = new Map();
    delivered.forEach((order) =>
      order.items.forEach((item) =>
        unique.set(item.productId.toString(), {
          productId: item.productId,
          name: item.name,
          image: item.image,
        }),
      ),
    );
    const reviews = await db
      .collection("reviews")
      .find({ userId: req.user._id })
      .toArray();
    res.json({ products: [...unique.values()], reviews });
  });
  app.put("/api/reviews/:id", auth, async (req, res) => {
    const productId = oid(req.params.id);
    const input = z
      .object({
        rating: z.number().int().min(1).max(5),
        comment: z.string().trim().min(10).max(1200),
      })
      .parse(req.body);
    const purchased = await db.collection("orders").findOne({
      userId: req.user._id,
      status: "delivered",
      "items.productId": productId,
    });
    if (!purchased)
      throw new HttpError(
        403,
        "Reviews are available after your item is delivered.",
      );
    await db.collection("reviews").updateOne(
      { productId, userId: req.user._id },
      {
        $set: { ...input, userName: req.user.name, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    res.json({ ok: true });
  });

  app.post("/api/payments/ssl/ipn", async (req, res) => {
    const validationId = z.string().min(1).max(200).parse(req.body.val_id);
    await service.settle(validationId);
    res.json({ ok: true });
  });
  app.post("/api/payments/ssl/:result", async (req, res) => {
    const result = z
      .enum(["success", "fail", "cancel"])
      .parse(req.params.result);
    const order = await db.collection("orders").findOne({
      _id: oid(req.query.order),
      callbackToken: z.string().length(48).parse(req.query.token),
    });
    if (!order) throw new HttpError(400, "Invalid payment return.");
    let state = result;
    if (result === "success") {
      try {
        if (req.body.tran_id !== order.transactionId)
          throw new HttpError(400, "Transaction mismatch.");
        await service.settle(z.string().min(1).max(200).parse(req.body.val_id));
      } catch {
        state = "pending-verification";
      }
    }
    // A browser redirect is only navigation; the result page fetches real DB payment state.
    res.redirect(
      303,
      `${config.clientOrigin}/checkout/result?order=${order._id}&return=${state}`,
    );
  });

  app.use("/api/admin", auth, admin);
  app.get("/api/admin/products", (req, res) => listProducts(req, res, true));
  app.get("/api/admin/products/:id", async (req, res) => {
    const product = await db
      .collection("products")
      .findOne({ _id: oid(req.params.id) });
    if (!product) throw new HttpError(404, "Product not found.");
    res.json({ product });
  });
  app.post("/api/admin/products", async (req, res) => {
    const { price, cost, ...input } = productSchema.parse(req.body);
    const slug = `${input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
    const product = {
      ...input,
      slug,
      pricePaisa: moneyToPaisa(price),
      costPaisa: moneyToPaisa(cost),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    product._id = (
      await db.collection("products").insertOne(product)
    ).insertedId;
    res.status(201).json({ product });
  });
  app.patch("/api/admin/products/:id", async (req, res) => {
    const { price, cost, ...input } = productSchema.parse(req.body);
    const version = z.iso.datetime().parse(req.body.version);
    const result = await db.collection("products").updateOne(
      { _id: oid(req.params.id), updatedAt: new Date(version) },
      {
        $set: {
          ...input,
          isSample: false,
          pricePaisa: moneyToPaisa(price),
          costPaisa: moneyToPaisa(cost),
          updatedAt: new Date(),
        },
      },
    );
    if (!result.matchedCount)
      throw new HttpError(
        409,
        "Product or stock changed while you were editing. Reload before saving.",
      );
    res.json({ ok: true });
  });
  app.patch("/api/admin/products/:id/feature", async (req, res) => {
    const { featured } = z.object({ featured: z.boolean() }).parse(req.body);
    const result = await db
      .collection("products")
      .updateOne(
        { _id: oid(req.params.id), active: true },
        { $set: { featured, updatedAt: new Date() } },
      );
    if (!result.matchedCount)
      throw new HttpError(404, "Active product not found.");
    res.json({ ok: true });
  });
  app.delete("/api/admin/products/:id", async (req, res) => {
    const result = await db.collection("products").updateOne(
      { _id: oid(req.params.id) },
      {
        $set: {
          active: false,
          featured: false,
          archivedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
    if (!result.matchedCount) throw new HttpError(404, "Product not found.");
    res.json({ ok: true });
  });
  app.get("/api/admin/users", async (req, res) => {
    const { page, limit } = pagination(req.query);
    const filter = req.query.search
      ? {
          $or: [
            {
              name: {
                $regex: escapeRegex(textQuery(req.query.search)),
                $options: "i",
              },
            },
            {
              email: {
                $regex: escapeRegex(textQuery(req.query.search)),
                $options: "i",
              },
            },
          ],
        }
      : {};
    const [users, total] = await Promise.all([
      db
        .collection("users")
        .find(filter)
        .project({ passwordHash: 0 })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      db.collection("users").countDocuments(filter),
    ]);
    res.json({
      users: users.map(safeUser),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  });
  app.patch("/api/admin/users/:id", async (req, res) => {
    const userId = oid(req.params.id);
    const { blocked } = z.object({ blocked: z.boolean() }).parse(req.body);
    await transaction(client, async (session) => {
      const result = await db
        .collection("users")
        .updateOne(
          { _id: userId, role: "user" },
          { $set: { blocked } },
          { session },
        );
      if (!result.matchedCount)
        throw new HttpError(400, "Admin accounts cannot be blocked here.");
      if (blocked)
        await db.collection("authSessions").deleteMany({ userId }, { session });
    });
    res.json({ ok: true });
  });
  app.get("/api/admin/orders", async (req, res) => {
    const { page, limit } = pagination(req.query);
    const filter = {};
    if (req.query.status)
      filter.status = z
        .enum([
          "pending",
          "processing",
          "shipped",
          "delivered",
          "cancelled",
          "awaiting_payment",
          "expired",
          "payment_review",
        ])
        .parse(req.query.status);
    if (req.query.method)
      filter.paymentMethod = z
        .enum(["cod", "bkash", "nagad"])
        .parse(req.query.method);
    if (req.query.paid === "true") filter.paymentStatus = "paid";
    if (req.query.wallets === "true" && !filter.paymentMethod)
      filter.paymentMethod = { $in: ["bkash", "nagad"] };
    const [orders, total] = await Promise.all([
      db
        .collection("orders")
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      db.collection("orders").countDocuments(filter),
    ]);
    res.json({
      orders: orders.map(publicOrder),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  });
  app.patch("/api/admin/orders/:id", async (req, res) => {
    const { status } = z
      .object({
        status: z.enum(["processing", "shipped", "delivered", "cancelled"]),
      })
      .parse(req.body);
    res.json({
      order: publicOrder(
        await service.changeStatus(oid(req.params.id), status),
      ),
    });
  });
  app.get("/api/admin/overview", async (req, res) => {
    const now = new Date();
    const dhakaParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(now);
    const year = Number(dhakaParts.find((x) => x.type === "year").value),
      month = Number(dhakaParts.find((x) => x.type === "month").value) - 1;
    const start = new Date(Date.UTC(year, month - 5, 1) - 6 * 3600000);
    const [revenue, monthly, products, users, pending, recent] =
      await Promise.all([
        db
          .collection("orders")
          .aggregate([
            { $match: { paymentStatus: "paid" } },
            {
              $group: {
                _id: null,
                revenuePaisa: { $sum: "$subtotalPaisa" },
                profitPaisa: { $sum: "$grossProfitPaisa" },
                paidOrders: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        db
          .collection("orders")
          .aggregate([
            { $match: { paymentStatus: "paid", paidAt: { $gte: start } } },
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m",
                    date: "$paidAt",
                    timezone: "Asia/Dhaka",
                  },
                },
                revenue: { $sum: "$subtotalPaisa" },
                profit: { $sum: "$grossProfitPaisa" },
              },
            },
          ])
          .toArray(),
        db.collection("products").countDocuments({ active: true }),
        db.collection("users").countDocuments({ role: "user" }),
        db.collection("orders").countDocuments({
          status: {
            $in: ["pending", "processing", "shipped", "payment_review"],
          },
        }),
        db
          .collection("orders")
          .find({})
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray(),
      ]);
    const chart = Array.from({ length: 6 }, (_, i) => {
      const date = new Date(Date.UTC(year, month - 5 + i, 1));
      const key = date.toISOString().slice(0, 7);
      const row = monthly.find((x) => x._id === key);
      return {
        month: date.toLocaleDateString("en", {
          month: "short",
          year: "2-digit",
          timeZone: "UTC",
        }),
        revenue: (row?.revenue || 0) / 100,
        profit: (row?.profit || 0) / 100,
      };
    });
    res.json({
      stats: {
        revenuePaisa: 0,
        profitPaisa: 0,
        paidOrders: 0,
        ...revenue[0],
        products,
        users,
        pending,
      },
      chart,
      recent: recent.map(publicOrder),
    });
  });

  app.use((req, res) =>
    res.status(404).json({ message: "Endpoint not found." }),
  );
  app.use((error, req, res, next) => {
    if (error instanceof ZodError)
      return res.status(400).json({
        message: error.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join("; "),
      });
    if (error.code === 11000)
      return res
        .status(409)
        .json({ message: "This record already exists. Reload and try again." });
    const status =
      error.status || (error.type === "entity.parse.failed" ? 400 : 500);
    if (status >= 500)
      console.error("Request failed:", error.name, error.code || "", req.path);
    res.status(status).json({
      message:
        status >= 500 && !error.status
          ? "Something went wrong. Please try again."
          : error.message,
    });
  });
  return { app, service, auth: betterAuthInstance };
}
