/**
 * The fixed set of testnet identities a demo needs: a professional and a
 * client to exercise a booking, and an admin identity for the backend's
 * `PACTLY_ADMIN_WALLETS` role list (AD-12). The admin identity is a platform
 * authorization role only — it never signs a deposit function and is a
 * separate concept from the escrow contract's own `admin` parameter, which
 * this command does not set.
 */
import { Keypair } from "@stellar/stellar-sdk";

export type DemoRole = "admin" | "professional" | "client";

export const DEMO_ROLES: readonly DemoRole[] = ["admin", "professional", "client"];

/** Roles that transact the anchor's USDC and so need the trustline. */
export const TRUSTLINE_ROLES: readonly DemoRole[] = ["professional", "client"];

/** The `.env` key an operator places this role's secret key under. */
export function secretEnvVar(role: DemoRole): string {
  return `PACTLY_DEMO_${role.toUpperCase()}_SECRET`;
}

export interface ResolvedKeypair {
  keypair: Keypair;
  isNew: boolean;
}

/**
 * Reuses an operator-supplied secret key rather than silently overwriting it;
 * only generates a fresh keypair when the environment has none yet. A blank
 * string is treated the same as "no key set". `envVarName`, when given, names
 * the offending variable in the error message if the secret is malformed.
 */
export function resolveDemoKeypair(
  existingSecret: string | undefined,
  envVarName = "the demo account secret",
): ResolvedKeypair {
  const trimmed = existingSecret?.trim();
  if (trimmed) {
    try {
      return { keypair: Keypair.fromSecret(trimmed), isNew: false };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${envVarName} is not a valid Stellar secret key (${reason}). Fix or clear it in .env and re-run.`,
      );
    }
  }
  return { keypair: Keypair.random(), isNew: true };
}

/**
 * Folds the demo admin's public key into an existing, operator-managed
 * `PACTLY_ADMIN_WALLETS` list rather than replacing it — an operator who
 * added other admin wallets keeps them. De-duplicated, existing order
 * preserved, the demo admin appended only if not already present.
 */
export function unionAdminWallets(existingWallets: string | undefined, demoAdminPublicKey: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of (existingWallets ?? "").split(",")) {
    const wallet = raw.trim();
    if (wallet === "" || seen.has(wallet)) continue;
    seen.add(wallet);
    result.push(wallet);
  }
  if (!seen.has(demoAdminPublicKey)) {
    result.push(demoAdminPublicKey);
  }
  return result.join(",");
}
