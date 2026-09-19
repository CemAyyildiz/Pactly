import { serve } from "@hono/node-server";

import { config } from "./config.js";
import { createApp } from "./app.js";
import { openDatabase } from "./db/client.js";
import { startRunner } from "./runner.js";

const { db } = openDatabase(config.databasePath);
const app = createApp(db);

serve({ fetch: app.fetch, port: config.backendPort }, (info) => {
  console.log(`[backend] listening on http://localhost:${info.port}`);
});

// Story 3.4: the reconciler and hold-expiry ticks start here only -- never
// in `createApp` (which a unit test constructs directly, with no clock or
// network seam it wants running in the background) and never in a test.
startRunner(db);
