import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { HttpError } from "./domain.js";

export function validateAuthConfig() {
  if (!config.authSecret || config.authSecret.length < 32)
    throw new Error(
      "Set BETTER_AUTH_SECRET in the server .env to a random secret of at least 32 characters. Generate one with: openssl rand -base64 32",
    );
  for (const [name, value] of [
    ["CLIENT_ORIGIN", config.clientOrigin],
    ["BETTER_AUTH_URL", config.authUrl],
  ]) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== value)
      throw new Error(
        `${name} must be an exact origin without a path or trailing slash.`,
      );
    if (config.production && url.protocol !== "https:")
      throw new Error(`${name} must use HTTPS in production.`);
  }
  if (config.authUrl !== config.clientOrigin)
    throw new Error(
      "BETTER_AUTH_URL must match CLIENT_ORIGIN: auth requests use the Next.js /api proxy.",
    );
  if (config.sessionDays < 1 || config.sessionDays > 30)
    throw new Error("SESSION_DAYS must be between 1 and 30.");
}

// Migrated bcrypt credentials remain valid; new passwords use Better Auth's scrypt.
export async function verifyStoredPassword({ hash, password }) {
  if (/^\$2[aby]\$/.test(hash)) {
    if (Buffer.byteLength(password, "utf8") > 72) return false;
    return bcrypt.compare(password, hash);
  }
  return verifyPassword({ hash, password });
}

export function createAuth({ db, client, database, rateLimit = true }) {
  validateAuthConfig();
  return betterAuth({
    appName: "AVARIKA",
    baseURL: config.authUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.clientOrigin],
    database: database || mongodbAdapter(db, { client }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      password: { hash: hashPassword, verify: verifyStoredPassword },
    },
    user: {
      modelName: "users",
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "user",
          input: false,
        },
        blocked: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
    session: {
      modelName: "authSessions",
      expiresIn: config.sessionDays * 86400,
      updateAge: 86400,
      cookieCache: { enabled: false },
    },
    account: { modelName: "authAccounts" },
    verification: { modelName: "authVerifications" },
    advanced: {
      cookiePrefix: "avarika",
      ipAddress: { ipAddressHeaders: ["x-avarika-client-ip"] },
      useSecureCookies: config.production,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    rateLimit: { enabled: rateLimit, window: 60, max: 100 },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const name = user.name.trim();
            if (name.length < 2 || name.length > 100 || user.email.length > 254)
              throw new APIError("BAD_REQUEST", {
                message:
                  "Use a name of 2–100 characters and a valid email address.",
              });
            return { data: { ...user, name, role: "user", blocked: false } };
          },
        },
        update: {
          before: async (user) => {
            if (
              user.name !== undefined &&
              (user.name.trim().length < 2 || user.name.trim().length > 100)
            )
              throw new APIError("BAD_REQUEST", {
                message: "Use a name of 2–100 characters.",
              });
            return {
              data:
                user.name === undefined
                  ? user
                  : { ...user, name: user.name.trim() },
            };
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const user = await ctx.context.internalAdapter.findUserById(
              session.userId,
            );
            if (!user || user.blocked)
              throw new APIError("FORBIDDEN", {
                message: "This account is unavailable. Contact the store.",
              });
            return { data: session };
          },
        },
      },
    },
  });
}

export const safeUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  blocked: user.blocked,
  createdAt: user.createdAt,
});

export function authentication(db, betterAuthInstance) {
  return async (req, res, next) => {
    const session = await betterAuthInstance.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session?.user || !ObjectId.isValid(session.user.id))
      throw new HttpError(401, "Please log in to continue.");
    // Always load current privileges and block status from the commerce database.
    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(session.user.id) });
    if (!user || user.blocked)
      throw new HttpError(403, "This account is unavailable.");
    req.user = user;
    next();
  };
}

export function admin(req, res, next) {
  if (req.user.role !== "admin")
    throw new HttpError(403, "Admin access required.");
  next();
}
