import { connectDatabase } from "../src/db.js";
import { migrateLegacyAuth } from "../src/auth-migration.js";
const connection = await connectDatabase();
try {
  const count = await migrateLegacyAuth(connection);
  console.log(
    `Migrated ${count} account(s) to Better Auth. Existing passwords and user IDs were preserved. Users of the previous auth system must log in again.`,
  );
} finally {
  await connection.client.close();
}
