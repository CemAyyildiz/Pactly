/**
 * The only place SQL touches the passkey pivot's three tables: `users`
 * (one per person, carrying their custodial account), `passkey_credentials`
 * and `webauthn_challenges`. Read by `../auth/passkey.ts` and
 * `../custodial/*`; never by a route directly.
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { passkeyCredentials, users, webauthnChallenges, type WebauthnChallengeKind } from "./schema.js";

export type UserRow = typeof users.$inferSelect;
export type PasskeyCredentialRow = typeof passkeyCredentials.$inferSelect;
export type WebauthnChallengeRow = typeof webauthnChallenges.$inferSelect;

export async function getUserByWalletAddress(db: Db, walletAddress: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.walletAddress, walletAddress)).limit(1);
  return row;
}

export async function getUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export interface InsertUserInput {
  id: string;
  displayName: string;
  walletAddress: string;
  encryptedSecret: string;
  createdAt: number;
}

export interface InsertPasskeyCredentialInput {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: number;
}

/** Inserts the user and their first credential together -- either both
 * rows land or neither does (a credential id that already exists, say,
 * must never leave an orphan user holding a fresh custodial key nobody can
 * sign in to). better-sqlite3 transactions are synchronous end to end, so
 * the callback uses `.run()`, never `await`. */
export function insertUserWithCredentialSync(db: Db, user: InsertUserInput, credential: InsertPasskeyCredentialInput): void {
  db.transaction((tx) => {
    tx.insert(users).values(user).run();
    tx.insert(passkeyCredentials)
      .values({ ...credential, transports: JSON.stringify(credential.transports) })
      .run();
  });
}

/** Test-only seam (and a future "import an existing account" hook): a user
 * row with no passkey, for exercising the custodial signer directly. */
export async function insertUser(db: Db, user: InsertUserInput): Promise<void> {
  await db.insert(users).values(user);
}

export async function setUserAccountFlags(
  db: Db,
  userId: string,
  flags: { funded?: boolean; usdcTrustline?: boolean },
): Promise<void> {
  await db.update(users).set(flags).where(eq(users.id, userId));
}

export async function getPasskeyCredentialById(db: Db, id: string): Promise<PasskeyCredentialRow | undefined> {
  const [row] = await db.select().from(passkeyCredentials).where(eq(passkeyCredentials.id, id)).limit(1);
  return row;
}

export async function updatePasskeyCounter(db: Db, id: string, counter: number): Promise<void> {
  await db.update(passkeyCredentials).set({ counter }).where(eq(passkeyCredentials.id, id));
}

export interface InsertWebauthnChallengeInput {
  id: string;
  kind: WebauthnChallengeKind;
  challenge: string;
  userId?: string;
  displayName?: string;
  expiresAt: number;
}

export async function insertWebauthnChallenge(db: Db, input: InsertWebauthnChallengeInput): Promise<void> {
  await db.insert(webauthnChallenges).values({
    id: input.id,
    kind: input.kind,
    challenge: input.challenge,
    userId: input.userId ?? null,
    displayName: input.displayName ?? null,
    expiresAt: input.expiresAt,
  });
}

/**
 * Consumes a challenge: deletes the row and returns it, or `undefined` when
 * no row of that `kind` has that id (never issued, already consumed, or the
 * other ceremony's). Delete-and-return is one statement, so two concurrent
 * verifies of the same ceremony can never both succeed. An expired row is
 * still returned (and still deleted) -- the caller decides what expiry
 * means, since "gone" and "too old" map to the same response either way.
 */
export async function consumeWebauthnChallenge(
  db: Db,
  id: string,
  kind: WebauthnChallengeKind,
): Promise<WebauthnChallengeRow | undefined> {
  const [row] = await db
    .delete(webauthnChallenges)
    .where(and(eq(webauthnChallenges.id, id), eq(webauthnChallenges.kind, kind)))
    .returning();
  return row;
}
