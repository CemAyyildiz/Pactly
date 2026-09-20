import { serve } from "@hono/node-server";

import { boot } from "./boot.js";
import { config } from "./config.js";

const { app } = await boot();

serve({ fetch: app.fetch, port: config.backendPort }, (info) => {
  console.log(`[backend] listening on http://localhost:${info.port}`);
});
