import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { connectDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { migrateLegacyAuth } from "../src/auth-migration.js";

test(
  "MongoDB transactional commerce integration",
  { skip: !process.env.TEST_MONGODB_URI },
  async (t) => {
    // Uses a NEW isolated database and drops ONLY this generated database at the end.
    const name = `avarika_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const connection = await connectDatabase(
      process.env.TEST_MONGODB_URI,
      name,
    );
    const { db, client } = connection;
    const verified = new Map();
    const gateway = {
      create: async () => ({
        url: "https://sandbox.sslcommerz.com/test",
        sessionKey: "test",
      }),
      validate: async (id) => {
        if (!verified.has(id)) throw new Error("Unknown test validation");
        return verified.get(id);
      },
    };
    config.authSecret = "AVARIKA-integration-test-only-48f6cd1cbb99472b";
    config.authUrl = config.clientOrigin;
    config.production = false;
    const { app, service } = createApp({
      ...connection,
      gateway,
      skipRateLimit: true,
    });
    const customer = request.agent(app),
      other = request.agent(app),
      admin = request.agent(app);
    const post = (agent, path, body) =>
      agent.post(path).set("Origin", config.clientOrigin).send(body);
    const patch = (agent, path, body) =>
      agent.patch(path).set("Origin", config.clientOrigin).send(body);
    let product, order;
    const shipping = {
      name: "Test Buyer",
      phone: "01712345678",
      address: "House 1, Road 2, Dhanmondi",
      city: "Dhaka",
      area: "dhaka",
    };
    const payload = (quantity = 1, method = "cod") => ({
      items: [{ productId: product._id, quantity }],
      shipping,
      paymentMethod: method,
      idempotencyKey: crypto.randomUUID(),
      expectedTotalPaisa: quantity * 10000 + config.dhaka,
    });
    try {
      await db.collection("users").insertOne({
        name: "Test Admin",
        email: "admin@example.test",
        passwordHash: await bcrypt.hash("test-only-password", 4),
        role: "admin",
        blocked: false,
        createdAt: new Date(),
      });
      await t.test(
        "legacy auth migration preserves IDs, role, password, and cart references",
        async () => {
          const before = await db
            .collection("users")
            .findOne({ role: "admin" });
          await db
            .collection("carts")
            .insertOne({ userId: before._id, items: [] });
          await db
            .collection("sessions")
            .insertOne({
              userId: before._id,
              tokenHash: "legacy",
              expiresAt: new Date(Date.now() + 10000),
            });
          assert.equal(await migrateLegacyAuth(connection), 1);
          const after = await db
            .collection("users")
            .findOne({ _id: before._id });
          assert.equal(after.passwordHash, undefined);
          assert.equal(after.role, "admin");
          assert.equal(after.emailVerified, false);
          const account = await db
            .collection("authAccounts")
            .findOne({ userId: before._id });
          assert.equal(account.password, before.passwordHash);
          assert.equal(account.accountId, before._id.toString());
          assert.equal(await db.collection("sessions").countDocuments(), 0);
          assert.ok(
            await db.collection("carts").findOne({ userId: before._id }),
          );
          assert.equal(await migrateLegacyAuth(connection), 0);
        },
      );
      await t.test(
        "registration cannot self-promote and sessions authenticate",
        async () => {
          let a = await post(customer, "/api/auth/sign-up/email", {
            name: "Test Buyer",
            email: "buyer@example.test",
            password: "test-only-password",
            role: "admin",
          });
          if (a.status === 400)
            a = await post(customer, "/api/auth/sign-up/email", {
              name: "Test Buyer",
              email: "buyer@example.test",
              password: "test-only-password",
            });
          assert.equal(a.status, 200);
          assert.equal(a.body.user.role, "user");
          await post(other, "/api/auth/sign-up/email", {
            name: "Other Buyer",
            email: "other@example.test",
            password: "test-only-password",
          }).expect(200);
          await post(admin, "/api/auth/sign-in/email", {
            email: "admin@example.test",
            password: "test-only-password",
          }).expect(200);
        },
      );
      await t.test(
        "admin creates products; public responses omit costs",
        async () => {
          const r = await post(admin, "/api/admin/products", {
            name: "Test Ring",
            description: "An integration test ring, not a real product.",
            category: "Rings",
            price: 100,
            cost: 40,
            stock: 5,
            images: ["/images/ring.svg"],
            material: "Alloy",
            care: "Keep dry.",
            active: true,
            featured: true,
          }).expect(201);
          product = r.body.product;
          const list = await customer.get("/api/products").expect(200);
          assert.equal(list.body.products[0].costPaisa, undefined);
          await customer.get("/api/admin/products").expect(403);
        },
      );
      await t.test(
        "cart persists and checkout reserves stock only once",
        async () => {
          await customer
            .put(`/api/cart/${product._id}`)
            .set("Origin", config.clientOrigin)
            .send({ quantity: 2 })
            .expect(200);
          assert.equal(
            (await customer.get("/api/cart")).body.items[0].quantity,
            2,
          );
          const body = { ...payload(2), fromCart: true };
          order = (await post(customer, "/api/orders", body).expect(201)).body
            .order;
          const again = (await post(customer, "/api/orders", body).expect(201))
            .body.order;
          assert.equal(order._id, again._id);
          assert.equal(
            (
              await db
                .collection("products")
                .findOne({ _id: new ObjectId(product._id) })
            ).stock,
            3,
          );
          assert.equal((await customer.get("/api/cart")).body.items.length, 0);
          await other.get(`/api/orders/${order._id}`).expect(404);
        },
      );
      await t.test(
        "price tampering, unpaid reviews, and invalid transitions fail",
        async () => {
          await post(customer, "/api/orders", {
            ...payload(),
            expectedTotalPaisa: 1,
          }).expect(409);
          await customer
            .put(`/api/reviews/${product._id}`)
            .set("Origin", config.clientOrigin)
            .send({ rating: 5, comment: "I have not received this yet." })
            .expect(403);
          await patch(admin, `/api/admin/orders/${order._id}`, {
            status: "delivered",
          }).expect(409);
        },
      );
      await t.test(
        "COD delivery records collection and unlocks reviews",
        async () => {
          for (const status of ["processing", "shipped", "delivered"])
            await patch(admin, `/api/admin/orders/${order._id}`, {
              status,
            }).expect(200);
          const result = (await customer.get(`/api/orders/${order._id}`)).body
            .order;
          assert.equal(result.paymentStatus, "paid");
          await customer
            .put(`/api/reviews/${product._id}`)
            .set("Origin", config.clientOrigin)
            .send({ rating: 5, comment: "A useful verified review test." })
            .expect(200);
          const overview = (await admin.get("/api/admin/overview")).body;
          assert.equal(overview.stats.revenuePaisa, 20000);
          assert.equal(overview.stats.profitPaisa, 12000);
        },
      );
      await t.test(
        "concurrent last-stock checkout cannot oversell",
        async () => {
          await db
            .collection("products")
            .updateOne(
              { _id: new ObjectId(product._id) },
              { $set: { stock: 1 } },
            );
          const results = await Promise.all([
            post(customer, "/api/orders", payload()),
            post(other, "/api/orders", payload()),
          ]);
          assert.deepEqual(results.map((x) => x.status).sort(), [201, 409]);
          const winner = results.find((x) => x.status === 201).body.order;
          await service.release(new ObjectId(winner._id), "cancelled");
          assert.equal(
            (
              await db
                .collection("products")
                .findOne({ _id: new ObjectId(product._id) })
            ).stock,
            1,
          );
        },
      );
      await t.test(
        "wallet IPN is validated, idempotent, and rejects amount tampering",
        async () => {
          config.storeId = "test";
          config.storePassword = "test";
          const created = (
            await post(customer, "/api/orders", payload(1, "bkash")).expect(201)
          ).body.order;
          await patch(admin, `/api/admin/orders/${created._id}`, {
            status: "processing",
          }).expect(409);
          verified.set("wrong", {
            status: "VALID",
            tran_id: created.transactionId,
            amount: "1",
            currency: "BDT",
            val_id: "wrong",
            bank_gw: "bKash",
            risk_level: "0",
          });
          await request(app)
            .post("/api/payments/ssl/ipn")
            .send({ val_id: "wrong" })
            .expect(400);
          verified.set("good", {
            status: "VALID",
            tran_id: created.transactionId,
            amount: String(created.totalPaisa / 100),
            currency: "BDT",
            val_id: "good",
            bank_gw: "bKash",
            risk_level: "0",
          });
          await request(app)
            .post("/api/payments/ssl/ipn")
            .send({ val_id: "good" })
            .expect(200);
          await request(app)
            .post("/api/payments/ssl/ipn")
            .send({ val_id: "good" })
            .expect(200);
          assert.equal(
            (await customer.get(`/api/orders/${created._id}`)).body.order
              .paymentStatus,
            "paid",
          );
          await post(customer, `/api/orders/${created._id}/cancel`).expect(409);
        },
      );
      await t.test(
        "blocking revokes customer sessions and protects the admin",
        async () => {
          const buyer = await db
            .collection("users")
            .findOne({ email: "buyer@example.test" });
          await patch(admin, `/api/admin/users/${buyer._id}`, {
            blocked: true,
          }).expect(200);
          await customer.get("/api/orders").expect(401);
          await post(customer, "/api/auth/sign-in/email", {
            email: "buyer@example.test",
            password: "test-only-password",
          }).expect(403);
          const owner = await db.collection("users").findOne({ role: "admin" });
          await patch(admin, `/api/admin/users/${owner._id}`, {
            blocked: true,
          }).expect(400);
        },
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
