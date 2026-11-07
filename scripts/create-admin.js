import { hashPassword } from "better-auth/crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { connectDatabase, transaction } from "../src/db.js";
const input = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(128),
  })
  .parse({
    name: process.env.ADMIN_NAME,
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
const password = await hashPassword(input.password);
const { db, client } = await connectDatabase();
try {
  await transaction(client, async (session) => {
    if (
      await db.collection("users").findOne({ email: input.email }, { session })
    )
      throw new Error(
        "That account already exists. This command will not replace credentials or promote an existing customer. Migrate an existing admin with npm run migrate:auth.",
      );
    if (await db.collection("users").findOne({ role: "admin" }, { session }))
      throw new Error("An admin already exists. This is a single-owner shop.");
    const id = new ObjectId(),
      now = new Date();
    await db.collection("users").insertOne(
      {
        _id: id,
        name: input.name,
        email: input.email,
        emailVerified: false,
        role: "admin",
        blocked: false,
        createdAt: now,
        updatedAt: now,
      },
      { session },
    );
    // Matches the native MongoDB adapter's credential-account schema.
    await db.collection("authAccounts").insertOne(
      {
        userId: id,
        accountId: id.toString(),
        providerId: "credential",
        password,
        createdAt: now,
        updatedAt: now,
      },
      { session },
    );
  });
  console.log(
    "Admin created with Better Auth credentials. Remove ADMIN_PASSWORD from .env now.",
  );
} finally {
  await client.close();
}
