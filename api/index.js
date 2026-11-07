
import { createApp } from "../src/app.js";
import { validateAuthConfig } from "../src/auth.js";
import { connectDatabase } from "../src/db.js";

let appPromise;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      validateAuthConfig();

      const connection = await connectDatabase();
      const { app } = createApp(connection);

      return app;
    })();
  }

  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}