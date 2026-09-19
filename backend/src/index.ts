import { serve } from "@hono/node-server";

import { config } from "./config.js";
import { createApp } from "./app.js";
import { openDatabase } from "./db/client.js";

const { db } = openDatabase(config.databasePath);
const app = createApp(db);

serve({ fetch: app.fetch, port: config.backendPort }, (info) => {
  console.log(`[backend] listening on http://localhost:${info.port}`);
});
