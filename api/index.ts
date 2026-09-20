/**
 * Single Vercel Node handler for the complete Hono API.
 *
 * `vercel.json` rewrites `/api/:path*` here with the original path in the
 * `path` query parameter. Reconstructing the URL before handing it to Hono
 * avoids relying on framework-specific filesystem catch-all semantics.
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
  const rewritten = new URL(req.url ?? "/api", "http://localhost");
  const path = rewritten.searchParams.get("path") ?? "";
  rewritten.searchParams.delete("path");
  rewritten.pathname = `/api${path ? `/${path.replace(/^\/+/, "")}` : ""}`;
  req.url = `${rewritten.pathname}${rewritten.search}`;

  const listen = await getListener();
  await listen(req, res);
}
