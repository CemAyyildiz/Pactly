import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { categories } from "./schema.js";

export type CategoryRow = typeof categories.$inferSelect;

export async function getCategoryById(db: Db, id: string): Promise<CategoryRow | undefined> {
  const rows = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return rows[0];
}

/** Story 3.2: `GET /providers?category=<slug>` resolves the URL's slug to
 * a category id here first -- an unknown slug returns `undefined`, which
 * `services/profile.ts`'s `listDiscoverProviders` turns into an empty list
 * rather than an error (the spec's own "Unknown slug" row). */
export async function getCategoryBySlug(db: Db, slug: string): Promise<CategoryRow | undefined> {
  const rows = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return rows[0];
}

export async function listCategories(db: Db): Promise<CategoryRow[]> {
  return db.select().from(categories);
}
