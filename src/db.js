import { MongoClient } from "mongodb";
import { config } from "./config.js";
export async function connectDatabase(
  uri = config.mongoUri,
  name = config.dbName,
) {
  if (!uri)
    throw new Error(
      "Set MONGODB_URI in .env. MongoDB Atlas or a replica set is required.",
    );
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const hello = await client.db("admin").command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") {
    await client.close();
    throw new Error(
      "AVARIKA requires MongoDB Atlas or a replica set for atomic stock and order transactions. See README.md.",
    );
  }
  const db = client.db(name);
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db
      .collection("users")
      .createIndex(
        { role: 1 },
        { unique: true, partialFilterExpression: { role: "admin" } },
      ),
    db.collection("authSessions").createIndex({ token: 1 }, { unique: true }),
    db
      .collection("authSessions")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("authSessions").createIndex({ userId: 1 }),
    db
      .collection("authAccounts")
      .createIndex({ providerId: 1, accountId: 1 }, { unique: true }),
    db.collection("authAccounts").createIndex({ userId: 1 }),
    db.collection("authVerifications").createIndex({ identifier: 1 }),
    db
      .collection("authVerifications")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("products").createIndex({ slug: 1 }, { unique: true }),
    db
      .collection("products")
      .createIndex({ active: 1, featured: 1, category: 1, createdAt: -1 }),
    db.collection("carts").createIndex({ userId: 1 }, { unique: true }),
    db
      .collection("orders")
      .createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true }),
    db.collection("orders").createIndex({ transactionId: 1 }, { unique: true }),
    db
      .collection("orders")
      .createIndex({ validationId: 1 }, { unique: true, sparse: true }),
    db.collection("orders").createIndex({ userId: 1, createdAt: -1 }),
    db.collection("orders").createIndex({ status: 1, expiresAt: 1 }),
    db
      .collection("orders")
      .createIndex({ paymentMethod: 1, paymentStatus: 1, paidAt: -1 }),
    db
      .collection("reviews")
      .createIndex({ userId: 1, productId: 1 }, { unique: true }),
  ]);
  return { client, db };
}
export async function transaction(client, fn) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => fn(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
  } finally {
    await session.endSession();
  }
}
