import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { categories } from "./schema.js";

export type CategoryRow = typeof categories.$inferSelect;

export async function getCategoryById(db: Db, id: string): Promise<CategoryRow | undefined> {
  const rows = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return rows[0];
}

export async function listCategories(db: Db): Promise<CategoryRow[]> {
  return db.select().from(categories);
}
