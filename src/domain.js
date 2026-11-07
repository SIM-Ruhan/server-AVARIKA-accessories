import { z } from "zod";
import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const idSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid ID");
export const oid = (value) => new ObjectId(idSchema.parse(value));
export const categories = [
  "Earrings",
  "Necklaces",
  "Rings",
  "Bracelets",
  "Bangles",
  "Hair accessories",
];
export const moneyToPaisa = (value) => Math.round(Number(value) * 100);
const taka = z
  .number()
  .finite()
  .min(0)
  .max(1000000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.00001,
    "Use at most two decimal places",
  );
const image = z
  .string()
  .max(1500)
  .refine(
    (v) =>
      /^https:\/\/[^\s]+$/.test(v) || /^\/images\/[a-zA-Z0-9._/-]+$/.test(v),
    "Use an HTTPS image URL or /images/file.svg",
  );
export const productSchema = z.object({
  name: z.string().trim().min(3).max(100),
  description: z.string().trim().min(20).max(5000),
  category: z.enum(categories),
  price: taka.refine((n) => n > 0, "Price must be positive"),
  cost: taka,
  stock: z.number().int().min(0).max(100000),
  images: z.array(image).min(1).max(5),
  material: z.string().trim().min(2).max(150),
  care: z.string().trim().min(5).max(1000),
  featured: z.boolean().default(false),
  active: z.boolean().default(true),
});
export const shippingSchema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .regex(/^(?:\+?88)?01[3-9]\d{8}$/, "Enter a valid Bangladesh phone number"),
  address: z.string().trim().min(10).max(300),
  city: z.string().trim().min(2).max(80),
  area: z.enum(["dhaka", "outside"]),
  postalCode: z.string().trim().max(10).default(""),
  note: z.string().trim().max(500).default(""),
});
export const itemsSchema = z
  .array(
    z.object({
      productId: idSchema,
      quantity: z.number().int().min(1).max(20),
    }),
  )
  .min(1)
  .max(50);
export const checkoutSchema = z.object({
  items: itemsSchema,
  shipping: shippingSchema,
  paymentMethod: z.enum(["bkash", "nagad", "cod"]),
  idempotencyKey: z.string().uuid(),
  fromCart: z.boolean().default(false),
  expectedTotalPaisa: z.number().int().positive().max(10000000000),
});
export function normalizeItems(items) {
  const combined = new Map();
  for (const item of items)
    combined.set(
      item.productId,
      (combined.get(item.productId) || 0) + item.quantity,
    );
  const result = [...combined]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  if (result.some((x) => x.quantity > 20))
    throw new HttpError(400, "Maximum 20 of each item per order.");
  return result;
}
export function calculateTotals(products, items, shipping, settings) {
  const snapshots = items.map((item) => {
    const product = products.find((p) => p._id.toString() === item.productId);
    if (!product || !product.active)
      throw new HttpError(409, "A product is no longer available.");
    if (product.stock < item.quantity)
      throw new HttpError(
        409,
        `${product.name}: only ${product.stock} available.`,
      );
    return {
      productId: product._id,
      name: product.name,
      image: product.images[0],
      pricePaisa: product.pricePaisa,
      costPaisa: product.costPaisa,
      quantity: item.quantity,
    };
  });
  const subtotalPaisa = snapshots.reduce(
    (sum, x) => sum + x.pricePaisa * x.quantity,
    0,
  );
  const costPaisa = snapshots.reduce(
    (sum, x) => sum + x.costPaisa * x.quantity,
    0,
  );
  const shippingPaisa =
    subtotalPaisa >= settings.freeShipping
      ? 0
      : shipping.area === "dhaka"
        ? settings.dhaka
        : settings.outside;
  return {
    items: snapshots,
    subtotalPaisa,
    shippingPaisa,
    totalPaisa: subtotalPaisa + shippingPaisa,
    costPaisa,
    grossProfitPaisa: subtotalPaisa - costPaisa,
  };
}
export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export const publicProduct = (p) => {
  const { costPaisa, ...safe } = p;
  return safe;
};
export const publicOrder = (order) => {
  const {
    costPaisa,
    grossProfitPaisa,
    fingerprint: fp,
    idempotencyKey,
    validationId,
    callbackToken,
    gatewayUrl,
    gatewaySessionKey,
    gatewayLock,
    ...safe
  } = order;
  safe.items = safe.items.map(({ costPaisa, ...item }) => item);
  return safe;
};
export function assertPayment(order, result) {
  if (
    !["VALID", "VALIDATED"].includes(result.status) ||
    result.tran_id !== order.transactionId ||
    result.currency !== "BDT" ||
    moneyToPaisa(result.amount) !== order.totalPaisa ||
    !result.val_id
  ) {
    throw new HttpError(400, "Payment verification failed.");
  }
  const gateway =
    `${result.bank_gw || ""} ${result.card_type || ""}`.toLowerCase();
  return {
    needsReview:
      String(result.risk_level) !== "0" ||
      !gateway.includes(order.paymentMethod),
  };
}
