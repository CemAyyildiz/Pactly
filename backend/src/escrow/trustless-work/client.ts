/**
 * The Trustless Work escrow adapter (AD-8): every Trustless Work REST call
 * in this codebase goes through the six functions below, and no other
 * module builds a Trustless Work payload or opens a `TrustlessWorkClient`.
 *
 * Mirrors `chain/client.ts`'s shape exactly: network access sits entirely
 * behind `EscrowCallDeps`, one injected function per Trustless Work REST
 * call, each defaulting to the real `@trustless-work/escrow-js` client. A
 * caller that does not override a stage gets the real network; a test that
 * overrides every stage it exercises never touches it -- the only reason
 * this story is verifiable at all while `TRUSTLESS_WORK_API_URL` is empty
 * and no operator API key exists.
 *
 * **Protocol version.** This targets Trustless Work's Core v2 API via the
 * installed `@trustless-work/escrow-js@1.0.0-beta.1` -- confirmed against
 * its real, installed `.d.ts` files, not assumed from documentation alone.
 * Every escrow
 * this adapter builds is `"single-release"`, one milestone,
 * `approvalsTarget: 1` -- Pactly has no use for `"multi-release"` escrows
 * or `updateEscrow` (explicitly out of this story's scope).
 *
 * **Amount conversion (a real discrepancy from the spec).** The spec
 * assumed the SDK's `amount: number` fields were the same smallest-unit
 * integer Pactly already carries, narrowed to `number`. The installed
 * package's own README says otherwise, in its own words: "Amounts on reads
 * are human decimal strings ... do not divide by 1e7. Build/operate
 * payloads still use human numbers." So `DeploySingleReleaseEscrowPayload
 * .amount`, `FundEscrowPayload.amount` and `Distribution.amount` are all
 * **human-decimal** numbers (e.g. `1.5`, not `15000000`) -- this adapter is
 * the one place that divides Pactly's smallest-unit integer string down by
 * `10 ** ASSET_DECIMALS` before it ever reaches the SDK, with the
 * non-positive/safe-integer checks run on the smallest-unit integer first,
 * per this story's own hard rule. `ASSET_DECIMALS` is fixed at 7, matching
 * this codebase's own established USDC convention (`contracts/escrow/src/
 * types.rs`'s "7 decimals for USDC" and `epic-1-context.md`'s same note) --
 * not a Trustless Work constant, since the SDK's own types carry no decimals
 * field at all.
 */
import {
  TrustlessWorkClient,
  type ApproveMilestonesPayload,
  type AttributionHeaders,
  type BuildTransactionResponse,
  type DeployEscrowResponse,
  type DeploySingleReleaseEscrowPayload,
  type Distribution,
  type FundEscrowPayload,
  type Roles,
  type SendTransactionResponse,
  type SingleReleaseReleaseFundsPayload,
  type SingleReleaseResolveDisputePayload,
  type SingleReleaseStartDisputePayload,
} from "@trustless-work/escrow-js";

import { config } from "../../config.js";
import type {
  ApproveEscrowInput,
  DeployEscrowInput,
  DeployEscrowResult,
  EscrowAdapter,
  FundEscrowInput,
  ReleaseEscrowInput,
  ResolveDisputeInput,
  StartDisputeInput,
  SubmitTransactionResult,
  UnsignedTransaction,
} from "../interface.js";
import { EscrowConfigError, translateTrustlessWorkError } from "./errors.js";

/** Every escrow this adapter builds is single-release (see this module's
 * own top doc comment). */
const ESCROW_TYPE = "single-release" as const;

/** Fixed at 7 -- this codebase's own established USDC convention (see this
 * module's top doc comment), not a value the Trustless Work SDK exposes. */
const ASSET_DECIMALS = 7;
const SMALLEST_UNIT_SCALE = 10 ** ASSET_DECIMALS;

export interface EscrowCallDeps {
  apiUrl: string;
  apiKey: string;
  platformId: string;
  platformAddress: string;
  deployEscrow: (
    payload: DeploySingleReleaseEscrowPayload,
    attribution?: AttributionHeaders,
  ) => Promise<DeployEscrowResponse>;
  fundEscrow: (payload: FundEscrowPayload) => Promise<BuildTransactionResponse>;
  approveMilestones: (payload: ApproveMilestonesPayload) => Promise<BuildTransactionResponse>;
  releaseFunds: (payload: SingleReleaseReleaseFundsPayload) => Promise<BuildTransactionResponse>;
  startDispute: (payload: SingleReleaseStartDisputePayload) => Promise<BuildTransactionResponse>;
  resolveDispute: (payload: SingleReleaseResolveDisputePayload) => Promise<BuildTransactionResponse>;
  /** Story 3.4: the `sendTransaction` seam -- relays a caller-signed XDR to
   * Trustless Work's own `POST /stellar/send-transaction`, never building
   * or signing anything itself. */
  sendTransaction: (signedXdr: string) => Promise<SendTransactionResponse>;
}

function defaultDeps(overrides: Partial<EscrowCallDeps>): EscrowCallDeps {
  const apiUrl = overrides.apiUrl ?? config.trustlessWorkApiUrl;
  const apiKey = overrides.apiKey ?? config.trustlessWorkApiKey;
  const platformId = overrides.platformId ?? config.trustlessWorkPlatformId;
  const platformAddress = overrides.platformAddress ?? config.trustlessWorkPlatformAddress;

  // Constructed lazily, and only once: a caller who overrides every stage
  // it exercises (every unit test) never causes this to be built, let
  // alone contacted.
  let client: TrustlessWorkClient | undefined;
  const getClient = (): TrustlessWorkClient => {
    if (!apiUrl) {
      throw new EscrowConfigError(
        "TRUSTLESS_WORK_API_URL is empty. Configure the Trustless Work API base URL " +
          "before making an escrow call (see .env.example).",
      );
    }
    if (!apiKey) {
      throw new EscrowConfigError(
        "TRUSTLESS_WORK_API_KEY is empty. Configure the Trustless Work API key before making an escrow call " +
          "(see .env.example) -- refused up front rather than sent as a blank credential.",
      );
    }
    client ??= new TrustlessWorkClient({ baseURL: apiUrl, apiKey });
    return client;
  };

  return {
    apiUrl,
    apiKey,
    platformId,
    platformAddress,
    deployEscrow:
      overrides.deployEscrow ??
      ((payload, attribution) => getClient().rest.deployEscrow(payload, ESCROW_TYPE, attribution)),
    fundEscrow: overrides.fundEscrow ?? ((payload) => getClient().rest.fundEscrow(payload, ESCROW_TYPE)),
    approveMilestones:
      overrides.approveMilestones ?? ((payload) => getClient().rest.approveMilestones(payload, ESCROW_TYPE)),
    releaseFunds: overrides.releaseFunds ?? ((payload) => getClient().rest.releaseFunds(payload, ESCROW_TYPE)),
    startDispute: overrides.startDispute ?? ((payload) => getClient().rest.startDispute(payload, ESCROW_TYPE)),
    resolveDispute: overrides.resolveDispute ?? ((payload) => getClient().rest.resolveDispute(payload, ESCROW_TYPE)),
    sendTransaction: overrides.sendTransaction ?? ((signedXdr) => getClient().rest.sendTransaction(signedXdr)),
  };
}

/** Runs `fn`, translating whatever it throws into one of `errors.ts`'s
 * typed errors -- the one place every adapter function funnels its network
 * call through, per AD-8. An error this module already typed (an
 * {@link EscrowConfigError} the lazily-constructed client seam throws
 * before ever reaching the network, most notably) passes through
 * unchanged rather than being re-wrapped as a generic request failure. */
export async function callTrustlessWork<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EscrowConfigError) throw error;
    throw translateTrustlessWorkError(error);
  }
}

/** An integer string in the asset's smallest unit (AD-7) -- never a float.
 * Converts to Trustless Work's own human-decimal `number`, refusing first
 * (typed {@link EscrowConfigError}, before any network access) when the
 * value is not a positive integer, or would not survive the conversion
 * safely. The `Number.isSafeInteger` check runs on the smallest-unit
 * integer itself, before it is ever divided down -- never a bare
 * `Number(bigString)`. */
function toHumanAmount(amount: string): number {
  if (!/^\d+$/.test(amount)) {
    throw new EscrowConfigError(`amount must be a non-negative integer string, got "${amount}"`);
  }
  const smallestUnits = BigInt(amount);
  if (smallestUnits <= 0n) {
    throw new EscrowConfigError(`amount must be a positive integer, got "${amount}"`);
  }
  if (smallestUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EscrowConfigError(
      `amount "${amount}" exceeds the safe integer range for conversion to Trustless Work's numeric amount`,
    );
  }
  const smallestUnitsNumber = Number(smallestUnits);
  if (!Number.isSafeInteger(smallestUnitsNumber)) {
    throw new EscrowConfigError(
      `amount "${amount}" exceeds the safe integer range for conversion to Trustless Work's numeric amount`,
    );
  }
  return smallestUnitsNumber / SMALLEST_UNIT_SCALE;
}

function toUnsignedTransaction(response: BuildTransactionResponse): UnsignedTransaction {
  return { unsignedXdr: response.unsignedXdr, txHash: response.txHash };
}

/** Refuses before any SDK call (matching {@link toHumanAmount}'s own
 * discipline) when Pactly's own platform address is not configured --
 * `deploy` and `resolveDispute` are the two calls that bake it directly
 * into the payload (platform/disputeResolvers/admin roles), so a blank
 * value here would silently build a payload naming nobody rather than
 * failing loudly. */
function requirePlatformAddress(platformAddress: string): string {
  if (!platformAddress) {
    throw new EscrowConfigError(
      "TRUSTLESS_WORK_PLATFORM_ADDRESS is empty. Configure Pactly's own Stellar account before making this " +
        "escrow call (see .env.example).",
    );
  }
  return platformAddress;
}

/**
 * Builds the unsigned deploy XDR for a new single-release escrow, roles
 * exactly per the role map (Story 1.8): client as funder/approver,
 * provider as service provider/release signer/receiver, Pactly as
 * platform/dispute resolver.
 *
 * **`admin` role decision.** The real `Roles` type (v2) requires an
 * `admin` address that Story 1.8's seven-role map never named (the map
 * predates the SDK's own array-shaped, admin-bearing `Roles`). This
 * adapter assigns Pactly's own platform address (`config
 * .trustlessWorkPlatformAddress`) as `admin` -- Pactly is the only party
 * that ever deploys these escrows, and no other role is positioned to
 * administer one, so overloading Pactly's existing platform address onto
 * `admin` adds no new trust surface beyond what the role map already
 * concedes for `platform`/`disputeResolvers`. This is a trust assumption,
 * not a property Trustless Work enforces trustlessly, and is named here
 * plainly for that reason (AD-2: a Pactly-controlled signer must be
 * documented as a trust assumption, never described as trustless).
 */
export async function deploy(
  input: DeployEscrowInput,
  overrides: Partial<EscrowCallDeps> = {},
): Promise<DeployEscrowResult> {
  const deps = defaultDeps(overrides);
  const amount = toHumanAmount(input.amount);
  const platformAddress = requirePlatformAddress(deps.platformAddress);

  const roles: Roles = {
    approvers: [input.clientAddress],
    serviceProviders: [input.providerAddress],
    releaseSigners: [input.providerAddress],
    receiver: input.providerAddress,
    platform: platformAddress,
    disputeResolvers: [platformAddress],
    admin: platformAddress,
  };

  const payload: DeploySingleReleaseEscrowPayload = {
    signer: input.clientAddress,
    engagementId: input.bookingId,
    title: input.title,
    description: input.description,
    amount,
    // Pactly takes no Trustless-Work-side platform fee today; its own
    // deposit-rate economics (`provider_profiles.deposit_rate_bps`) are
    // computed entirely off-chain, before this adapter is ever called.
    platformFee: 0,
    roles,
    milestones: [{ description: input.description, approvalsTarget: 1 }],
    trustline: { contractId: input.tokenAddress, symbol: input.assetSymbol },
  };
  const attribution: AttributionHeaders | undefined = deps.platformId ? { platformId: deps.platformId } : undefined;

  const response = await callTrustlessWork(() => deps.deployEscrow(payload, attribution));
  return { contractId: response.contractId, unsignedXdr: response.unsignedXdr, txHash: response.txHash };
}

/** Builds the unsigned fund XDR for the client's own signature. */
export async function fund(
  input: FundEscrowInput,
  overrides: Partial<EscrowCallDeps> = {},
): Promise<UnsignedTransaction> {
  const deps = defaultDeps(overrides);
  const amount = toHumanAmount(input.amount);
  const payload: FundEscrowPayload = { amount, contractId: input.contractId, signer: input.clientAddress };
  const response = await callTrustlessWork(() => deps.fundEscrow(payload));
  return toUnsignedTransaction(response);
}

/** Builds the unsigned approve XDR for the client's (approver's) own
 * signature -- this escrow has exactly one milestone, so `milestoneIndexes`
 * is always `[0]`. */
export async function approve(
  input: ApproveEscrowInput,
  overrides: Partial<EscrowCallDeps> = {},
): Promise<UnsignedTransaction> {
  const deps = defaultDeps(overrides);
  const payload: ApproveMilestonesPayload = {
    contractId: input.contractId,
    approver: input.clientAddress,
    milestoneIndexes: [0],
  };
  const response = await callTrustlessWork(() => deps.approveMilestones(payload));
  return toUnsignedTransaction(response);
}

/** Builds the unsigned release XDR for the provider's own signature
 * (self-claim: release signer and receiver are the same party). */
export async function release(
  input: ReleaseEscrowInput,
  overrides: Partial<EscrowCallDeps> = {},
): Promise<UnsignedTransaction> {
  const deps = defaultDeps(overrides);
  const payload: SingleReleaseReleaseFundsPayload = {
    contractId: input.contractId,
    releaseSigner: input.providerAddress,
  };
  const response = await callTrustlessWork(() => deps.releaseFunds(payload));
  return toUnsignedTransaction(response);
}

/** Builds the unsigned start-dispute XDR for whichever party raises it
 * (the client as approver, or the provider) -- never Pactly itself, which
 * only ever signs {@link resolveDispute}. */
export async function startDispute(
  input: StartDisputeInput,
  overrides: Partial<EscrowCallDeps> = {},
): Promise<UnsignedTransaction> {
  const deps = defaultDeps(overrides);
  const payload: SingleReleaseStartDisputePayload = {
    contractId: input.contractId,
    signer: input.signerAddress,
    reason: input.reason,
  };
  const response = await callTrustlessWork(() => deps.startDispute(payload));
  return toUnsignedTransaction(response);
}

/**
 * Builds the unsigned resolve-dispute XDR -- the one adapter function
 * Pactly itself is ever the signer for (`disputeResolver`, per the role
 * map). Every cancellation, late-cancellation or no-show that the client
 * does not resolve by approving becomes a dispute Pactly resolves here,
 * explicitly, by naming a distribution -- never an outcome the protocol
 * enforces automatically on a deadline (Story 1.8 AC7). Nothing about this
 * function is triggered by a clock; it is only ever called on Pactly's own
 * explicit decision, made after the fact, not on any timing condition.
 */
export async function resolveDispute(
  input: ResolveDisputeInput,
  overrides: Partial<EscrowCallDeps> = {},
): Promise<UnsignedTransaction> {
  const deps = defaultDeps(overrides);
  const platformAddress = requirePlatformAddress(deps.platformAddress);

  // Validated here, before any SDK call, per this story's own Design Notes
  // ("The adapter's own resolveDispute still validates any list it is
  // given"): empty, and a duplicated address, are both refused outright --
  // `toHumanAmount` below already refuses a non-positive amount per
  // distribution, so a "0" share (silently expressing "all to one party" by
  // naming the other with nothing) is refused the same way a genuinely
  // negative one would be.
  if (input.distributions.length === 0) {
    throw new EscrowConfigError("resolveDispute requires at least one distribution");
  }
  const seenAddresses = new Set<string>();
  for (const distribution of input.distributions) {
    if (seenAddresses.has(distribution.address)) {
      throw new EscrowConfigError(`resolveDispute distributions must name each address at most once, got a duplicate "${distribution.address}"`);
    }
    seenAddresses.add(distribution.address);
  }

  const distributions: Distribution[] = input.distributions.map((distribution) => ({
    address: distribution.address,
    amount: toHumanAmount(distribution.amount),
  }));
  const payload: SingleReleaseResolveDisputePayload = {
    contractId: input.contractId,
    disputeResolver: platformAddress,
    distributions,
  };
  const response = await callTrustlessWork(() => deps.resolveDispute(payload));
  return toUnsignedTransaction(response);
}

/**
 * Relays a signature the caller's own wallet already produced -- for any of
 * the five unsigned XDRs the functions above return -- to Trustless Work's
 * own `POST /stellar/send-transaction`. This is the one adapter function
 * that ever crosses from "unsigned" to "on chain"; it still never signs
 * anything itself (the XDR arrives already signed) and its own successful
 * return is never treated as confirmed escrow evidence (AD-1) -- only the
 * reconciler's own read of Trustless Work's read model ever writes
 * `escrow_state` (see `escrow/interface.ts`'s own doc comment on this
 * method).
 */
export async function submit(
  signedXdr: string,
  overrides: Partial<EscrowCallDeps> = {},
): Promise<SubmitTransactionResult> {
  const deps = defaultDeps(overrides);
  const response = await callTrustlessWork(() => deps.sendTransaction(signedXdr));
  return { txHash: response.txHash };
}

/** Binds every function above to one fixed set of `EscrowCallDeps`
 * overrides, producing a plain {@link EscrowAdapter} -- the shape
 * `services/booking.ts` actually depends on, per `escrow/interface.ts`'s
 * own "never import a Trustless Work type directly" rule. A test that
 * wants Trustless-Work-level seams (network stages) calls the functions
 * above directly, the same way `chain-client.test.ts` calls
 * `chain/client.ts`'s exports directly; a test of `services/booking.ts`
 * only ever needs a fake `EscrowAdapter`. */
export function createEscrowAdapter(overrides: Partial<EscrowCallDeps> = {}): EscrowAdapter {
  return {
    deploy: (input) => deploy(input, overrides),
    fund: (input) => fund(input, overrides),
    approve: (input) => approve(input, overrides),
    release: (input) => release(input, overrides),
    startDispute: (input) => startDispute(input, overrides),
    resolveDispute: (input) => resolveDispute(input, overrides),
    submit: (signedXdr) => submit(signedXdr, overrides),
  };
}

/** The real adapter, wired to `config` -- what `services/booking.ts`
 * defaults to. Never constructed by a test. */
export const defaultEscrowAdapter: EscrowAdapter = createEscrowAdapter();
