/**
 * The only place SQL touches the `used_challenge_nonces` table -- Pactly's
 * own challenge replay guard (`../auth/challenge.ts`).
 */
import type { Db } from "./client.js";
import { usedChallengeNonces } from "./schema.js";

/**
 * Records `nonce` as redeemed, unless it already was. Returns `true` when
 * this call is the one that redeemed it (first use), `false` when it was
 * already redeemed (a replay) -- nothing is written in that case. A plain
 * insert-then-check-conflict, so the check and the write are the same
 * atomic statement; there is no read-then-write race for a caller to lose.
 */
export async function redeemChallengeNonceIfUnused(
  db: Db,
  nonce: string,
  expiresAt: number,
  usedAt: number = Date.now(),
): Promise<boolean> {
  const result = await db.insert(usedChallengeNonces).values({ nonce, expiresAt, usedAt }).onConflictDoNothing();
  return result.changes === 1;
}
