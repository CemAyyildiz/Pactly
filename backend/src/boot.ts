/**
 * Shared process boot for the local Node listener and the Vercel
 * serverless handler: open SQLite, seed demo listings if the file is
 * empty, start the reconciler. `createApp` itself stays side-effect free
 * so unit tests keep constructing it directly.
 */
import { createApp, type App } from "./app.js";
import { config } from "./config.js";
import { openDatabase, type Db } from "./db/client.js";
import { listCategories } from "./db/categories.js";
import { seedDemoData } from "./seed/demoData.js";
import { startRunner } from "./runner.js";

export interface BootedServer {
  db: Db;
  app: App;
}

let booting: Promise<BootedServer> | undefined;

async function seedIfEmpty(db: Db): Promise<void> {
  const existing = await listCategories(db);
  if (existing.length > 0) {
    return;
  }
  await seedDemoData(db, "[boot]");
}

export function boot(): Promise<BootedServer> {
  if (!booting) {
    booting = (async () => {
      const { db } = openDatabase(config.databasePath);
      await seedIfEmpty(db);
      startRunner(db);
      return { db, app: createApp(db) };
    })();
  }
  return booting as Promise<BootedServer>;
}
