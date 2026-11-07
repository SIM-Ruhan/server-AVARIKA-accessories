import { ObjectId } from "mongodb";
import { transaction } from "./db.js";

// Stop the old server before running this migration. No user IDs are changed.
export async function migrateLegacyAuth({ db, client }) {
  let migrated = 0;
  const cursor = db
    .collection("users")
    .find({ passwordHash: { $exists: true } });
  for await (const legacy of cursor) {
    const changed = await transaction(client, async (session) => {
      const user = await db
        .collection("users")
        .findOne({ _id: legacy._id }, { session });
      if (!user || !Object.hasOwn(user, "passwordHash")) return false;
      if (
        !(user._id instanceof ObjectId) ||
        !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.passwordHash)
      )
        throw new Error(
          `Cannot migrate user ${user._id}: unsupported ID or password hash. This user's credentials were not replaced.`,
        );
      if (!["user", "admin"].includes(user.role))
        throw new Error(`Cannot migrate user ${user._id}: unexpected role.`);
      const key = { providerId: "credential", accountId: user._id.toString() };
      const existing = await db
        .collection("authAccounts")
        .findOne(key, { session });
      if (
        existing &&
        (existing.userId.toString() !== user._id.toString() ||
          existing.password !== user.passwordHash)
      )
        throw new Error(
          `A conflicting Better Auth credential exists for user ${user._id}; review it before migrating.`,
        );
      const now = new Date();
      if (!existing)
        await db.collection("authAccounts").insertOne(
          {
            ...key,
            userId: user._id,
            password: user.passwordHash,
            createdAt: user.createdAt || now,
            updatedAt: now,
          },
          { session },
        );
      await db.collection("users").updateOne(
        { _id: user._id },
        {
          $set: {
            emailVerified: user.emailVerified === true,
            blocked: user.blocked === true,
            updatedAt: now,
          },
          $unset: { passwordHash: "" },
        },
        { session },
      );
      return true;
    });
    if (changed) migrated++;
  }
  // Custom sessions are no longer accepted. Better Auth sessions are left intact on reruns.
  await db.collection("sessions").deleteMany({});
  return migrated;
}
