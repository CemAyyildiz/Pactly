/**
 * Vercel Node handler: same Hono app as local `backend/src/index.ts`,
 * mounted at `/api` so the frontend's `/api/*` fetches keep working
 * without the Vite proxy.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";

import { boot } from "../backend/src/boot.js";
import { runRunnerTicksOnce } from "../backend/src/runner.js";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

let listener: ReturnType<typeof getRequestListener> | undefined;

async function getListener(): Promise<ReturnType<typeof getRequestListener>> {
  if (!listener) {
    const { app, db } = await boot();
    const root = new Hono();
    root.route("/api", app);
    listener = getRequestListener(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.includes("/bookings") || url.pathname === "/api/health") {
        await runRunnerTicksOnce(db);
      }
      return root.fetch(request);
    });
  }
  return listener;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const listen = await getListener();
  await listen(req, res);
}
