import { connectDatabase } from "./db.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { validateAuthConfig } from "./auth.js";
validateAuthConfig();
const connection = await connectDatabase();
if (
  await connection.db
    .collection("users")
    .findOne({ passwordHash: { $exists: true } })
) {
  await connection.client.close();
  throw new Error(
    "Legacy accounts found. Stop the old server and run npm run migrate:auth once before starting this version.",
  );
}
const { app, service } = createApp(connection);
await service.expire();
const timer = setInterval(
  () =>
    service
      .expire()
      .catch((error) =>
        console.error("Reservation cleanup failed:", error.name),
      ),
  60000,
);
timer.unref();
const server = app.listen(config.port, () =>
  console.log(`AVARIKA API listening on port ${config.port}`),
);
async function shutdown() {
  clearInterval(timer);
  server.close(async () => {
    await connection.client.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
