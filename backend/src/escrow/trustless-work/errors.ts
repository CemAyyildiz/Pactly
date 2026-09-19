/**
 * Typed application errors for every way a Trustless Work escrow call can
 * fail, mirroring `chain/errors.ts`'s shape: a caller of `client.ts` never
 * sees a raw Trustless Work SDK error, HTTP body or `fetch` failure, only
 * one of these three.
 */
import {
  TrustlessWorkApiError,
  TrustlessWorkNetworkError,
  toTrustlessWorkError,
  type ApiErrorCode,
} from "@trustless-work/escrow-js";

/** `TRUSTLESS_WORK_API_URL` is empty, or an amount this adapter was asked
 * to send could not be safely converted to Trustless Work's own numeric
 * amount (non-positive, or outside the safe-integer range). Refused before
 * any network access, per this story's own constraint -- the I/O matrix
 * names this same class for both the config gap and the amount refusals. */
export class EscrowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowConfigError";
  }
}

/** Trustless Work's own API refused the call -- an RFC 9457 Problem
 * Details response, translated from the real SDK's `TrustlessWorkApiError`.
 * `.code` is Trustless Work's own machine-readable code (e.g.
 * `"ESCROW_PLATFORM_FEE_TOO_HIGH"`, `"UNAUTHORIZED"`) so a caller can
 * branch on it without parsing `.message`; `.status` is the HTTP status,
 * when known. Never carries the raw response body. */
export class EscrowApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EscrowApiError";
  }
}

/** Everything that is not a Trustless Work API-level refusal: the request
 * never reached Trustless Work (network/timeout failure, translated from
 * the real SDK's `TrustlessWorkNetworkError`), or a raw `fetch` failure the
 * SDK itself did not recognize as Problem Details. Still typed, still
 * never a raw string or stack trace handed straight to a caller. */
export class EscrowRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowRequestError";
  }
}

/**
 * Translates whatever a Trustless Work SDK call throws into one of this
 * module's typed errors. Uses the real package's own `toTrustlessWorkError`
 * normalizer (never a hand-rolled re-parse of the error shape) to recognize
 * its two error classes; anything else (a bare `TypeError` from `fetch`
 * itself, for instance) still becomes a typed {@link EscrowRequestError}
 * rather than escaping raw.
 */
export function translateTrustlessWorkError(error: unknown): EscrowApiError | EscrowRequestError {
  const normalized = toTrustlessWorkError(error);
  if (normalized instanceof TrustlessWorkApiError) {
    return new EscrowApiError(
      normalized.code,
      `Trustless Work refused the call: ${normalized.detail || normalized.title} (${normalized.code}).`,
      normalized.status,
    );
  }
  if (normalized instanceof TrustlessWorkNetworkError) {
    // `status` is `0` for a request that never got an HTTP response at all
    // (a timeout, a DNS failure, `fetch` throwing before any socket
    // opened) -- "HTTP 0" reads as a typo rather than what it is, so that
    // case gets its own wording instead of the generic "(HTTP N)" one.
    const statusPart = normalized.status > 0 ? ` (HTTP ${normalized.status})` : "";
    return new EscrowRequestError(`Could not reach Trustless Work${statusPart}: ${normalized.message}`);
  }
  const message = normalized instanceof Error ? normalized.message : String(normalized);
  return new EscrowRequestError(`Trustless Work request failed: ${message}`);
}
