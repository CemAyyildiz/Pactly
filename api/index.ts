/**
 * Single Vercel Node handler for the complete Hono API.
 *
 * `vercel.json` rewrites `/api/:path*` here with the original path in the
 * `path` query parameter. Reconstructing the URL before handing it to Hono
 * avoids relying on framework-specific filesystem catch-all semantics.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { getRequestListener } from "@hono/node-server";
import { get, put } from "@vercel/blob";
import { Hono } from "hono";

import { createApp } from "../backend/src/app.js";
import { closeDatabase, openDatabase } from "../backend/src/db/client.js";
import { listCategories } from "../backend/src/db/categories.js";
import { runRunnerTicksOnce } from "../backend/src/runner.js";
import { seedDemoData } from "../backend/src/seed/demoData.js";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

const DATABASE_BLOB_PATH = "pactly/state.sqlite";

async function restoreDatabase(path: string): Promise<void> {
  const stored = await get(DATABASE_BLOB_PATH, { access: "private", useCache: false });
  if (stored?.statusCode === 200) {
    const bytes = Buffer.from(await new Response(stored.stream).arrayBuffer());
    await writeFile(path, bytes);
  }
}

function requestCanChangeState(method: string | undefined, pathname: string): boolean {
  return method !== "GET" || pathname.includes("/bookings") || pathname === "/api/health";
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rewritten = new URL(req.url ?? "/api", "http://localhost");
  const path = rewritten.searchParams.get("path") ?? "";
  rewritten.searchParams.delete("path");
  rewritten.pathname = `/api${path ? `/${path.replace(/^\/+/, "")}` : ""}`;
  req.url = `${rewritten.pathname}${rewritten.search}`;

  const directory = `/tmp/pactly-${randomUUID()}`;
  const databasePath = `${directory}/state.sqlite`;
  await mkdir(directory, { recursive: true });

  let deferredEnd: Parameters<ServerResponse["end"]> | undefined;
  let listenerCompleted = false;
  const originalEnd = res.end.bind(res);
  res.end = ((...args: Parameters<ServerResponse["end"]>) => {
    deferredEnd = args;
    return res;
  }) as ServerResponse["end"];

  try {
    await restoreDatabase(databasePath);
    const database = openDatabase(databasePath);
    try {
      if ((await listCategories(database.db)).length === 0) {
        await seedDemoData(database.db, "[vercel]");
      }
      const root = new Hono();
      root.route("/api", createApp(database.db));
      const listen = getRequestListener(async (request) => {
        const url = new URL(request.url);
        if (url.pathname.includes("/bookings") || url.pathname === "/api/health") {
          await runRunnerTicksOnce(database.db);
        }
        return root.fetch(request);
      });
      await listen(req, res);
      listenerCompleted = true;
    } finally {
      closeDatabase(database);
    }

    if (requestCanChangeState(req.method, rewritten.pathname)) {
      await put(DATABASE_BLOB_PATH, await readFile(databasePath), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/vnd.sqlite3",
        cacheControlMaxAge: 60,
      });
    }
  } finally {
    res.end = originalEnd as ServerResponse["end"];
    if (deferredEnd) {
      originalEnd(...deferredEnd);
    } else if (listenerCompleted && !res.writableEnded) {
      originalEnd();
    }
    await rm(directory, { recursive: true, force: true });
  }
}
