import { config, walletsEnabled } from "./config.js";
import { HttpError } from "./domain.js";
const host = () =>
  config.sslLive
    ? "https://securepay.sslcommerz.com"
    : "https://sandbox.sslcommerz.com";
async function request(path, fields, method = "POST") {
  const data = new URLSearchParams({
    store_id: config.storeId,
    store_passwd: config.storePassword,
    ...fields,
  });
  const response = await fetch(
    `${host()}${path}${method === "GET" ? `?${data}` : ""}`,
    {
      method,
      ...(method === "POST" ? { body: data } : {}),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok)
    throw new HttpError(
      502,
      "The payment provider is temporarily unavailable.",
    );
  return response.json();
}
export const paymentGateway = {
  async create(order, user) {
    if (!walletsEnabled())
      throw new HttpError(
        503,
        "Online payments are not configured yet. Choose cash on delivery.",
      );
    const callback = `${config.publicApiUrl}/api/payments/ssl`;
    const token = `token=${order.callbackToken}&order=${order._id}`;
    const result = await request("/gwprocess/v4/api.php", {
      total_amount: (order.totalPaisa / 100).toFixed(2),
      currency: "BDT",
      tran_id: order.transactionId,
      success_url: `${callback}/success?${token}`,
      fail_url: `${callback}/fail?${token}`,
      cancel_url: `${callback}/cancel?${token}`,
      ipn_url: `${callback}/ipn`,
      multi_card_name: config.walletChannels[order.paymentMethod],
      cus_name: order.shipping.name,
      cus_email: user.email,
      cus_add1: order.shipping.address,
      cus_city: order.shipping.city,
      cus_postcode: order.shipping.postalCode || "0000",
      cus_country: "Bangladesh",
      cus_phone: order.shipping.phone,
      shipping_method: "YES",
      num_of_item: String(order.items.reduce((sum, x) => sum + x.quantity, 0)),
      ship_name: order.shipping.name,
      ship_add1: order.shipping.address,
      ship_city: order.shipping.city,
      ship_postcode: order.shipping.postalCode || "0000",
      ship_country: "Bangladesh",
      product_name: order.items
        .map((x) => x.name)
        .join(", ")
        .slice(0, 240),
      product_category: "Accessories",
      product_profile: "physical-goods",
    });
    if (result.status !== "SUCCESS" || !result.GatewayPageURL)
      throw new HttpError(
        502,
        "Unable to open wallet checkout. Check the merchant configuration.",
      );
    const url = new URL(result.GatewayPageURL);
    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "sslcommerz.com" ||
        url.hostname.endsWith(".sslcommerz.com")
      )
    )
      throw new HttpError(502, "Invalid checkout destination.");
    return { url: url.href, sessionKey: result.sessionkey || "" };
  },
  validate(validationId) {
    if (!walletsEnabled())
      throw new HttpError(503, "Online payments are not configured.");
    return request(
      "/validator/api/validationserverAPI.php",
      { val_id: validationId, format: "json", v: "1" },
      "GET",
    );
  },
};
