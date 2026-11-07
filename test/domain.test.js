import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  normalizeItems,
  calculateTotals,
  assertPayment,
  publicOrder,
  publicProduct,
  productSchema,
  shippingSchema,
  checkoutSchema,
  moneyToPaisa,
} from "../src/domain.js";
const id = new ObjectId();
const product = {
  _id: id,
  name: "Test ring",
  active: true,
  stock: 3,
  pricePaisa: 129000,
  costPaisa: 49000,
  images: ["/images/ring.svg"],
};
const settings = { dhaka: 8000, outside: 13000, freeShipping: 300000 };
test("money uses integer paisa without floating-point accumulation", () => {
  assert.equal(moneyToPaisa(10.29), 1029);
  assert.equal(moneyToPaisa("12.35"), 1235);
});
test("duplicate product lines combine before stock validation", () => {
  assert.deepEqual(
    normalizeItems([
      { productId: String(id), quantity: 1 },
      { productId: String(id), quantity: 2 },
    ]),
    [{ productId: String(id), quantity: 3 }],
  );
});
test("combined quantity cannot exceed the per-product limit", () =>
  assert.throws(
    () =>
      normalizeItems([
        { productId: String(id), quantity: 12 },
        { productId: String(id), quantity: 10 },
      ]),
    /Maximum 20/,
  ));
test("prices and costs come from the database, not cart input", () => {
  const total = calculateTotals(
    [product],
    [{ productId: String(id), quantity: 2, pricePaisa: 1 }],
    { area: "dhaka" },
    settings,
  );
  assert.equal(total.subtotalPaisa, 258000);
  assert.equal(total.shippingPaisa, 8000);
  assert.equal(total.totalPaisa, 266000);
  assert.equal(total.grossProfitPaisa, 160000);
});
test("free shipping applies at the configured threshold", () => {
  const total = calculateTotals(
    [{ ...product, pricePaisa: 100000 }],
    [{ productId: String(id), quantity: 3 }],
    { area: "outside" },
    settings,
  );
  assert.equal(total.shippingPaisa, 0);
});
test("outside-Dhaka charge is applied below the threshold", () => {
  const total = calculateTotals(
    [product],
    [{ productId: String(id), quantity: 1 }],
    { area: "outside" },
    settings,
  );
  assert.equal(total.shippingPaisa, 13000);
});
test("insufficient stock prevents checkout", () =>
  assert.throws(
    () =>
      calculateTotals(
        [product],
        [{ productId: String(id), quantity: 4 }],
        { area: "dhaka" },
        settings,
      ),
    /only 3/,
  ));
test("archived or missing products cannot be bought", () => {
  assert.throws(
    () =>
      calculateTotals(
        [{ ...product, active: false }],
        [{ productId: String(id), quantity: 1 }],
        { area: "dhaka" },
        settings,
      ),
    /no longer available/,
  );
  assert.throws(() =>
    calculateTotals(
      [],
      [{ productId: String(id), quantity: 1 }],
      { area: "dhaka" },
      settings,
    ),
  );
});
const order = {
  transactionId: "AV123",
  paymentMethod: "bkash",
  totalPaisa: 129000,
};
const validation = {
  status: "VALID",
  tran_id: "AV123",
  amount: "1290.00",
  currency: "BDT",
  val_id: "validated-1",
  bank_gw: "bKash",
  risk_level: "0",
};
test("valid bKash provider result is accepted", () =>
  assert.deepEqual(assertPayment(order, validation), { needsReview: false }));
test("idempotent VALIDATED response is accepted", () =>
  assert.deepEqual(
    assertPayment(order, { ...validation, status: "VALIDATED" }),
    { needsReview: false },
  ));
test("Nagad is checked against the verified provider channel", () =>
  assert.deepEqual(
    assertPayment(
      { ...order, paymentMethod: "nagad" },
      { ...validation, bank_gw: "NAGAD" },
    ),
    { needsReview: false },
  ));
test("forged amount, currency, transaction, status, or missing validation is rejected", () => {
  for (const override of [
    { amount: "1" },
    { currency: "USD" },
    { tran_id: "AV999" },
    { status: "FAILED" },
    { val_id: "" },
  ])
    assert.throws(
      () => assertPayment(order, { ...validation, ...override }),
      /verification failed/,
    );
});
test("provider risk or wrong wallet requires manual review", () => {
  assert.equal(
    assertPayment(order, { ...validation, risk_level: "1" }).needsReview,
    true,
  );
  assert.equal(
    assertPayment(order, { ...validation, bank_gw: "NAGAD" }).needsReview,
    true,
  );
  assert.equal(
    assertPayment(order, { ...validation, risk_level: undefined }).needsReview,
    true,
  );
});
test("product cost never appears in public product responses", () =>
  assert.equal(publicProduct(product).costPaisa, undefined));
test("customer orders omit internal secrets and margins", () => {
  const safe = publicOrder({
    ...order,
    costPaisa: 3,
    grossProfitPaisa: 9,
    validationId: "secret",
    callbackToken: "secret",
    gatewaySessionKey: "secret",
    gatewayUrl: "private",
    items: [{ costPaisa: 3, name: "Ring" }],
  });
  for (const key of [
    "costPaisa",
    "grossProfitPaisa",
    "validationId",
    "callbackToken",
    "gatewaySessionKey",
    "gatewayUrl",
  ])
    assert.equal(safe[key], undefined);
  assert.equal(safe.items[0].costPaisa, undefined);
});
test("product validation rejects unsafe images and fractional stock", () => {
  const p = {
    name: "Test ring",
    description: "A long enough description for this test product.",
    category: "Rings",
    price: 100,
    cost: 40,
    stock: 2,
    images: ["javascript:alert(1)"],
    material: "Alloy",
    care: "Keep dry.",
  };
  assert.equal(productSchema.safeParse(p).success, false);
  assert.equal(
    productSchema.safeParse({ ...p, images: ["/images/ring.svg"], stock: 1.5 })
      .success,
    false,
  );
  assert.equal(
    productSchema.safeParse({ ...p, images: ["/images/ring.svg"] }).success,
    true,
  );
});
test("shipping rejects non-Bangladesh phone and missing address", () => {
  const s = {
    name: "Buyer",
    phone: "01712345678",
    address: "House 1, Road 3, Dhaka",
    city: "Dhaka",
    area: "dhaka",
  };
  assert.equal(shippingSchema.safeParse(s).success, true);
  assert.equal(shippingSchema.safeParse({ ...s, phone: "123" }).success, false);
  assert.equal(shippingSchema.safeParse({ ...s, address: "" }).success, false);
});
test("checkout requires an expected total and supported payment method", () => {
  const c = {
    items: [{ productId: String(id), quantity: 1 }],
    shipping: {
      name: "Buyer",
      phone: "01712345678",
      address: "House 1, Road 3",
      city: "Dhaka",
      area: "dhaka",
    },
    paymentMethod: "cod",
    idempotencyKey: crypto.randomUUID(),
    expectedTotalPaisa: 137000,
  };
  assert.equal(checkoutSchema.safeParse(c).success, true);
  assert.equal(
    checkoutSchema.safeParse({ ...c, paymentMethod: "stripe" }).success,
    false,
  );
  assert.equal(
    checkoutSchema.safeParse({ ...c, expectedTotalPaisa: undefined }).success,
    false,
  );
});
