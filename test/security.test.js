import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { ObjectId } from "mongodb";
import { memoryAdapter } from "better-auth/adapters/memory";
import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { createApp } from "../src/app.js";
import {
  createAuth,
  validateAuthConfig,
  verifyStoredPassword,
} from "../src/auth.js";
import { config } from "../src/config.js";

// The real Better Auth HTTP handler runs against its official memory adapter.
// Commerce storage below is a fixture; native MongoDB has a separate integration suite.
config.authSecret =
  "AVARIKA-tests-only-1d51c7e3a098-44dd-never-use-in-production";
config.authUrl = config.clientOrigin;
config.production = false;
const data = {
  users: [],
  authAccounts: [],
  authSessions: [],
  authVerifications: [],
};
const database = (options) =>
  memoryAdapter(data)({
    ...options,
    advanced: {
      ...options.advanced,
      database: { generateId: () => new ObjectId().toString() },
    },
  });
const betterAuth = createAuth({ database, rateLimit: false });
const db = {
  collection(name) {
    return {
      async findOne(query) {
        if (name !== "users") return null;
        const user = data.users.find((u) => u.id === query._id?.toString());
        return user ? { ...user, _id: new ObjectId(user.id) } : null;
      },
      find() {
        return { toArray: async () => [] };
      },
    };
  },
};
const { app } = createApp({
  db,
  client: {},
  skipRateLimit: true,
  authInstance: betterAuth,
});
const post = (agent, path, body) =>
  agent.post(path).set("Origin", config.clientOrigin).send(body);
const credentials = {
  name: "Test Buyer",
  email: "buyer@example.test",
  password: "test-only-password",
};

test("Better Auth HTTP flows and commerce authorization", async (t) => {
  const buyer = request.agent(app);
  let cookie, userId;
  await t.test("anonymous requests cannot access admin data", async () => {
    await request(app).get("/api/admin/products").expect(401);
  });
  await t.test(
    "cross-origin and originless mutations are rejected",
    async () => {
      await request(app)
        .post("/api/auth/sign-up/email")
        .set("Origin", "https://untrusted.example")
        .send(credentials)
        .expect(403);
      await request(app)
        .post("/api/auth/sign-up/email")
        .send(credentials)
        .expect(403);
    },
  );
  await t.test(
    "malformed credentials and weak passwords are rejected",
    async () => {
      await post(buyer, "/api/auth/sign-up/email", {
        ...credentials,
        email: { $ne: null },
      }).expect(400);
      await post(buyer, "/api/auth/sign-up/email", {
        ...credentials,
        password: "short",
      }).expect(400);
      await post(buyer, "/api/auth/sign-up/email", {
        ...credentials,
        password: "x".repeat(129),
      }).expect(400);
      await post(buyer, "/api/auth/sign-up/email", {
        ...credentials,
        name: " ",
      }).expect(400);
    },
  );
  await t.test(
    "registration creates a scrypt credential and signed HttpOnly cookie",
    async () => {
      const r = await post(
        buyer,
        "/api/auth/sign-up/email",
        credentials,
      ).expect(200);
      userId = r.body.user.id;
      assert.equal(r.body.user.role, "user");
      assert.equal(r.body.user.blocked, false);
      assert.ok(ObjectId.isValid(userId));
      assert.equal(r.body.user.password, undefined);
      assert.equal(r.body.user.passwordHash, undefined);
      cookie = r.headers["set-cookie"].find((c) =>
        c.startsWith("avarika.session_token="),
      );
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.ok(data.authAccounts[0].password.includes(":"));
      assert.notEqual(data.authAccounts[0].password, credentials.password);
      assert.equal(data.authAccounts[0].providerId, "credential");
      assert.equal(data.authAccounts[0].userId, userId);
    },
  );
  await t.test(
    "a persisted session authenticates commerce and returns only public user fields",
    async () => {
      const r = await buyer.get("/api/auth/get-session?role=admin").expect(200);
      assert.equal(r.body.user.id, userId);
      assert.equal(r.body.user.role, "user");
      assert.equal(r.body.user.passwordHash, undefined);
      assert.equal(r.headers["cache-control"], "no-store");
      await buyer.get("/api/cart").expect(200);
      await buyer.get("/api/admin/users").expect(403);
    },
  );
  await t.test(
    "sign-up and update-user cannot assign admin or unblock accounts",
    async () => {
      const r = await post(request(app), "/api/auth/sign-up/email", {
        ...credentials,
        email: "spoof@example.test",
        role: "admin",
        blocked: true,
      });
      assert.ok([200, 400].includes(r.status));
      const spoof = data.users.find((u) => u.email === "spoof@example.test");
      if (spoof) {
        assert.equal(spoof.role, "user");
        assert.equal(spoof.blocked, false);
      }
      const update = await post(buyer, "/api/auth/update-user", {
        name: "Test Buyer",
        role: "admin",
        blocked: true,
      });
      assert.ok([200, 400].includes(update.status));
      assert.equal(data.users.find((u) => u.id === userId).role, "user");
      assert.equal(data.users.find((u) => u.id === userId).blocked, false);
    },
  );
  await t.test("duplicate email cannot replace credentials", async () => {
    const before = data.users.length;
    const r = await post(request(app), "/api/auth/sign-up/email", {
      ...credentials,
      password: "different-password",
    });
    assert.ok([400, 422].includes(r.status));
    assert.equal(data.users.length, before);
  });
  await t.test(
    "tampered cookies and old custom cookies fail authentication",
    async () => {
      await request(app)
        .get("/api/cart")
        .set("Cookie", "avarika.session_token=forged")
        .expect(401);
      await request(app)
        .get("/api/cart")
        .set("Cookie", `avarika_session=${"a".repeat(64)}`)
        .expect(401);
    },
  );
  await t.test(
    "sign-out revokes the session including replay of the old cookie",
    async () => {
      await post(buyer, "/api/auth/sign-out", {}).expect(200);
      await buyer.get("/api/cart").expect(401);
      await request(app)
        .get("/api/cart")
        .set("Cookie", cookie.split(";")[0])
        .expect(401);
    },
  );
  await t.test(
    "wrong passwords fail and valid credentials log in again",
    async () => {
      await post(buyer, "/api/auth/sign-in/email", {
        ...credentials,
        password: "incorrect-password",
      }).expect(401);
      await post(buyer, "/api/auth/sign-in/email", credentials).expect(200);
      await buyer.get("/api/cart").expect(200);
    },
  );
  await t.test(
    "database block status denies active sessions and new logins",
    async () => {
      data.users.find((u) => u.id === userId).blocked = true;
      await buyer.get("/api/cart").expect(403);
      await post(request(app), "/api/auth/sign-in/email", credentials).expect(
        403,
      );
      data.users.find((u) => u.id === userId).blocked = false;
    },
  );
  await t.test("expired sessions cannot authorize commerce", async () => {
    for (const s of data.authSessions.filter((s) => s.userId === userId))
      s.expiresAt = new Date(0);
    await buyer.get("/api/cart").expect(401);
  });
  await t.test(
    "migrated bcrypt credentials log in without changing the user's ID",
    async () => {
      const id = new ObjectId().toString(),
        now = new Date();
      data.users.push({
        id,
        name: "Existing Admin",
        email: "legacy@example.test",
        role: "admin",
        blocked: false,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
      data.authAccounts.push({
        id: new ObjectId().toString(),
        userId: id,
        accountId: id,
        providerId: "credential",
        password: await bcrypt.hash(credentials.password, 4),
        createdAt: now,
        updatedAt: now,
      });
      const admin = request.agent(app);
      const r = await post(admin, "/api/auth/sign-in/email", {
        email: "legacy@example.test",
        password: credentials.password,
      }).expect(200);
      assert.equal(r.body.user.id, id);
      assert.equal(r.body.user.role, "admin");
      // Reaches product validation after both real session and admin checks.
      await post(admin, "/api/admin/products", {}).expect(400);
    },
  );
  await t.test(
    "invalid payment callback cannot mark an order paid",
    async () => {
      await request(app)
        .post("/api/payments/ssl/ipn")
        .send({ status: "VALID", amount: 1 })
        .expect(400);
    },
  );
});

test("password verification supports scrypt and legacy bcrypt without truncation", async () => {
  const password = "a-secure-test-password";
  assert.equal(
    await verifyStoredPassword({
      hash: await hashPassword(password),
      password,
    }),
    true,
  );
  const long = "x".repeat(72),
    hash = await bcrypt.hash(long, 4);
  assert.equal(await verifyStoredPassword({ hash, password: long }), true);
  assert.equal(
    await verifyStoredPassword({ hash, password: long + "ignored-by-bcrypt" }),
    false,
  );
});

test("production rejects missing secrets and insecure origins", () => {
  const saved = { ...config };
  try {
    config.authSecret = "";
    assert.throws(validateAuthConfig, /BETTER_AUTH_SECRET/);
    config.authSecret = saved.authSecret;
    config.production = true;
    assert.throws(validateAuthConfig, /HTTPS/);
  } finally {
    Object.assign(config, saved);
  }
});

test("login throttling cannot be bypassed with a caller-supplied IP header", async () => {
  const authInstance = createAuth({ database });
  const { app: limited } = createApp({ db, client: {}, authInstance });
  for (let i = 0; i < 4; i++) {
    const response = await post(
      request(limited),
      "/api/auth/sign-in/email",
      {},
    ).set("x-avarika-client-ip", `192.0.2.${i + 1}`);
    assert.equal(response.status, i < 3 ? 400 : 429);
    if (i === 3) assert.ok(Number(response.headers["x-retry-after"]) > 0);
  }
});

test("production registration sets a Secure HttpOnly cookie", async () => {
  const saved = { ...config };
  try {
    config.production = true;
    config.authUrl = config.clientOrigin = "https://shop.example.test";
    const auth = createAuth({ database, rateLimit: false });
    const response = await auth.handler(
      new Request("https://shop.example.test/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: config.clientOrigin,
        },
        body: JSON.stringify({ ...credentials, email: "secure@example.test" }),
      }),
    );
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.includes("avarika.session_token="));
    assert.match(cookie, /; Secure/i);
    assert.match(cookie, /; HttpOnly/i);
    assert.match(cookie, /; SameSite=Lax/i);
  } finally {
    Object.assign(config, saved);
  }
});
