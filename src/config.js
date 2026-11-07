import "dotenv/config";
const number = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
};
export const config = {
  port: number("PORT", 5000),
  production: process.env.NODE_ENV === "production",
  mongoUri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB || "avarika",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  publicApiUrl: (process.env.PUBLIC_API_URL || "http://localhost:5000").replace(
    /\/$/,
    "",
  ),
  authUrl:
    process.env.BETTER_AUTH_URL ||
    process.env.CLIENT_ORIGIN ||
    "http://localhost:3000",
  authSecret: process.env.BETTER_AUTH_SECRET,
  trustProxy: number("TRUST_PROXY", 0),
  sessionDays: number("SESSION_DAYS", 7),
  dhaka: Math.round(number("SHIPPING_DHAKA", 80) * 100),
  outside: Math.round(number("SHIPPING_OUTSIDE", 130) * 100),
  freeShipping: Math.round(number("FREE_SHIPPING_THRESHOLD", 3000) * 100),
  storeEmail: process.env.STORE_EMAIL || "",
  storeId: process.env.SSLCOMMERZ_STORE_ID || "",
  storePassword: process.env.SSLCOMMERZ_STORE_PASSWORD || "",
  sslLive: process.env.SSLCOMMERZ_LIVE === "true",
  walletChannels: {
    bkash: process.env.SSLCOMMERZ_BKASH_CHANNEL || "bkash",
    nagad: process.env.SSLCOMMERZ_NAGAD_CHANNEL || "nagad",
  },
};
export const walletsEnabled = () =>
  Boolean(config.storeId && config.storePassword);
