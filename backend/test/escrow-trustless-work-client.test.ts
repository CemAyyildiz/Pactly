/**
 * `escrow/trustless-work/client.ts` exercised as a unit: every network
 * stage (`deployEscrow`, `fundEscrow`, `approveMilestones`, `releaseFunds`,
 * `startDispute`, `resolveDispute`) is overridden via `EscrowCallDeps`, so
 * nothing here ever reaches `dev.api.trustlesswork.com`,
 * `api.trustlesswork.com`, or any other real host. Covers every I/O-matrix
 * row this story's spec names for the adapter: every mutate call's success
 * path (not only its refusals), the two amount refusals, the empty-config
 * refusal, and the two error-translation rows.
 */
import "./testConfigEnv.js";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  TrustlessWorkApiError,
  TrustlessWorkNetworkError,
  type ApiProblemDetails,
  type ApproveMilestonesPayload,
  type BuildTransactionResponse,
  type DeployEscrowResponse,
  type DeploySingleReleaseEscrowPayload,
  type FundEscrowPayload,
  type SingleReleaseReleaseFundsPayload,
  type SingleReleaseResolveDisputePayload,
  type SingleReleaseStartDisputePayload,
} from "@trustless-work/escrow-js";

import { approve, deploy, fund, release, resolveDispute, startDispute, type EscrowCallDeps } from "../src/escrow/trustless-work/client.js";
import { EscrowApiError, EscrowConfigError, EscrowRequestError } from "../src/escrow/trustless-work/errors.js";
import type {
  ApproveEscrowInput,
  DeployEscrowInput,
  FundEscrowInput,
  ReleaseEscrowInput,
  ResolveDisputeInput,
  StartDisputeInput,
} from "../src/escrow/interface.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function fakeAddress(): string {
  return Keypair.random().publicKey();
}

/** Every network stage throws if called -- a test using this fails loudly
 * if the code under test does not refuse before reaching it (mirrors
 * `chain-client.test.ts`'s own `unreachableStages`). */
function unreachableStages(): Pick<
  EscrowCallDeps,
  "deployEscrow" | "fundEscrow" | "approveMilestones" | "releaseFunds" | "startDispute" | "resolveDispute"
> {
  return {
    deployEscrow: async () => {
      throw new Error("deployEscrow should not have been called");
    },
    fundEscrow: async () => {
      throw new Error("fundEscrow should not have been called");
    },
    approveMilestones: async () => {
      throw new Error("approveMilestones should not have been called");
    },
    releaseFunds: async () => {
      throw new Error("releaseFunds should not have been called");
    },
    startDispute: async () => {
      throw new Error("startDispute should not have been called");
    },
    resolveDispute: async () => {
      throw new Error("resolveDispute should not have been called");
    },
  };
}

function baseDeployInput(overrides: Partial<DeployEscrowInput> = {}): DeployEscrowInput {
  return {
    bookingId: randomBytes(16).toString("hex"),
    clientAddress: fakeAddress(),
    providerAddress: fakeAddress(),
    tokenAddress: fakeContractId(),
    assetSymbol: "USDC",
    amount: "10000000",
    title: "Pactly booking",
    description: "Pactly session deposit",
    ...overrides,
  };
}

test("deploy sends V2 array-shaped roles -- exactly one address per role, per the role map -- and converts the amount to a human decimal", async () => {
  let captured: { payload: DeploySingleReleaseEscrowPayload; attribution?: { platformId?: string } } | undefined;
  const platformAddress = fakeAddress();
  const clientAddress = fakeAddress();
  const providerAddress = fakeAddress();

  const deps: Partial<EscrowCallDeps> = {
    platformAddress,
    platformId: "pactly",
    ...unreachableStages(),
    deployEscrow: async (payload, attribution) => {
      captured = { payload, attribution };
      return {
        contractId: "predicted-contract-id",
        unsignedXdr: "deploy-unsigned-xdr",
        txHash: "deploy-tx-hash",
      } satisfies DeployEscrowResponse;
    },
  };

  const result = await deploy(baseDeployInput({ clientAddress, providerAddress, amount: "10000000" }), deps);

  assert.equal(result.contractId, "predicted-contract-id");
  assert.equal(result.unsignedXdr, "deploy-unsigned-xdr");
  assert.equal(result.txHash, "deploy-tx-hash");

  assert.ok(captured, "deployEscrow should have been called");
  const { payload, attribution } = captured;
  assert.deepEqual(payload.roles, {
    approvers: [clientAddress],
    serviceProviders: [providerAddress],
    releaseSigners: [providerAddress],
    receiver: providerAddress,
    platform: platformAddress,
    disputeResolvers: [platformAddress],
    admin: platformAddress,
  });
  assert.equal(payload.signer, clientAddress);
  assert.equal(payload.milestones.length, 1);
  assert.equal(payload.milestones[0]?.approvalsTarget, 1);
  // 10_000_000 smallest units / 10**7 (7-decimal USDC convention) === 1.
  assert.equal(payload.amount, 1);
  assert.equal(attribution?.platformId, "pactly");
});

test("deploy's engagementId is the Pactly booking id (AD-13)", async () => {
  let captured: DeploySingleReleaseEscrowPayload | undefined;
  const bookingId = randomBytes(16).toString("hex");
  const deps: Partial<EscrowCallDeps> = {
    platformAddress: fakeAddress(),
    ...unreachableStages(),
    deployEscrow: async (payload) => {
      captured = payload;
      return { contractId: "c", unsignedXdr: "x", txHash: "h" } satisfies DeployEscrowResponse;
    },
  };
  await deploy(baseDeployInput({ bookingId }), deps);
  assert.equal(captured?.engagementId, bookingId);
});

test("fund builds the unsigned fund XDR for the client's own signature", async () => {
  let captured: FundEscrowPayload | undefined;
  const clientAddress = fakeAddress();
  const contractId = "predicted-contract-id";
  const deps: Partial<EscrowCallDeps> = {
    ...unreachableStages(),
    fundEscrow: async (payload) => {
      captured = payload;
      return { unsignedXdr: "fund-unsigned-xdr", txHash: "fund-tx-hash" } satisfies BuildTransactionResponse;
    },
  };
  const input: FundEscrowInput = { contractId, clientAddress, amount: "5000000" };
  const result = await fund(input, deps);

  assert.equal(result.unsignedXdr, "fund-unsigned-xdr");
  assert.equal(result.txHash, "fund-tx-hash");
  assert.ok(captured);
  assert.equal(captured.contractId, contractId);
  assert.equal(captured.signer, clientAddress);
  assert.equal(captured.amount, 0.5);
});

test("approve builds the unsigned approve XDR for the client (approver), milestone index [0]", async () => {
  let captured: ApproveMilestonesPayload | undefined;
  const clientAddress = fakeAddress();
  const contractId = "predicted-contract-id";
  const deps: Partial<EscrowCallDeps> = {
    ...unreachableStages(),
    approveMilestones: async (payload) => {
      captured = payload;
      return { unsignedXdr: "approve-unsigned-xdr", txHash: "approve-tx-hash" } satisfies BuildTransactionResponse;
    },
  };
  const input: ApproveEscrowInput = { contractId, clientAddress };
  const result = await approve(input, deps);

  assert.equal(result.unsignedXdr, "approve-unsigned-xdr");
  assert.ok(captured);
  assert.equal(captured.approver, clientAddress);
  assert.deepEqual(captured.milestoneIndexes, [0]);
});

test("release builds the unsigned release XDR for the provider's own signature (self-claim)", async () => {
  let captured: SingleReleaseReleaseFundsPayload | undefined;
  const providerAddress = fakeAddress();
  const contractId = "predicted-contract-id";
  const deps: Partial<EscrowCallDeps> = {
    ...unreachableStages(),
    releaseFunds: async (payload) => {
      captured = payload;
      return { unsignedXdr: "release-unsigned-xdr", txHash: "release-tx-hash" } satisfies BuildTransactionResponse;
    },
  };
  const input: ReleaseEscrowInput = { contractId, providerAddress };
  const result = await release(input, deps);

  assert.equal(result.unsignedXdr, "release-unsigned-xdr");
  assert.ok(captured);
  assert.equal(captured.releaseSigner, providerAddress, "release signer must be the provider (self-claim)");
});

test("startDispute builds the unsigned start-dispute XDR for whichever party raises it", async () => {
  let captured: SingleReleaseStartDisputePayload | undefined;
  const signerAddress = fakeAddress();
  const contractId = "predicted-contract-id";
  const deps: Partial<EscrowCallDeps> = {
    ...unreachableStages(),
    startDispute: async (payload) => {
      captured = payload;
      return { unsignedXdr: "dispute-unsigned-xdr", txHash: "dispute-tx-hash" } satisfies BuildTransactionResponse;
    },
  };
  const input: StartDisputeInput = { contractId, signerAddress, reason: "provider no-show" };
  const result = await startDispute(input, deps);

  assert.equal(result.unsignedXdr, "dispute-unsigned-xdr");
  assert.ok(captured);
  assert.equal(captured.signer, signerAddress);
  assert.equal(captured.reason, "provider no-show");
});

test("resolveDispute builds the unsigned resolve-dispute XDR naming Pactly as disputeResolver, with named distributions", async () => {
  let captured: SingleReleaseResolveDisputePayload | undefined;
  const platformAddress = fakeAddress();
  const clientAddress = fakeAddress();
  const providerAddress = fakeAddress();
  const contractId = "predicted-contract-id";
  const deps: Partial<EscrowCallDeps> = {
    platformAddress,
    ...unreachableStages(),
    resolveDispute: async (payload) => {
      captured = payload;
      return { unsignedXdr: "resolve-unsigned-xdr", txHash: "resolve-tx-hash" } satisfies BuildTransactionResponse;
    },
  };
  const input: ResolveDisputeInput = {
    contractId,
    distributions: [
      { address: clientAddress, amount: "3000000" },
      { address: providerAddress, amount: "7000000" },
    ],
  };
  const result = await resolveDispute(input, deps);

  assert.equal(result.unsignedXdr, "resolve-unsigned-xdr");
  assert.ok(captured);
  assert.equal(captured.disputeResolver, platformAddress, "Pactly signs dispute resolution as Dispute Resolver");
  assert.deepEqual(captured.distributions, [
    { address: clientAddress, amount: 0.3 },
    { address: providerAddress, amount: 0.7 },
  ]);
});

test("a non-positive amount refuses before any network access, with a typed EscrowConfigError", async () => {
  const deps: Partial<EscrowCallDeps> = { platformAddress: fakeAddress(), ...unreachableStages() };
  await assert.rejects(() => deploy(baseDeployInput({ amount: "0" }), deps), EscrowConfigError);
  await assert.rejects(
    () => fund({ contractId: "c", clientAddress: fakeAddress(), amount: "-1" }, deps),
    // A negative amount does not even match the integer-string pattern, so
    // this also exercises the "not an integer string" branch of the same
    // typed refusal.
    EscrowConfigError,
  );
});

test("an amount that cannot safely narrow to Trustless Work's numeric amount refuses before any network access, naming the value", async () => {
  const deps: Partial<EscrowCallDeps> = { platformAddress: fakeAddress(), ...unreachableStages() };
  const hugeAmount = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
  await assert.rejects(() => deploy(baseDeployInput({ amount: hugeAmount }), deps), (error: unknown) => {
    assert.ok(error instanceof EscrowConfigError);
    assert.match(error.message, new RegExp(hugeAmount));
    return true;
  });
});

test("an empty TRUSTLESS_WORK_API_URL refuses before any network access", async () => {
  // `apiKey` is deliberately non-empty here -- otherwise this test cannot
  // tell "refused because of the URL" apart from "refused because of the
  // key" (both throw the same `EscrowConfigError` class), so it would keep
  // passing even if the two checks' order were ever swapped.
  const deps: Partial<EscrowCallDeps> = { apiUrl: "", apiKey: "some-key", platformAddress: fakeAddress() };
  await assert.rejects(() => deploy(baseDeployInput(), deps), (error: unknown) => {
    assert.ok(error instanceof EscrowConfigError);
    assert.match(error.message, /TRUSTLESS_WORK_API_URL/);
    return true;
  });
});

test("an empty TRUSTLESS_WORK_API_KEY refuses before any network access", async () => {
  const deps: Partial<EscrowCallDeps> = { apiUrl: "https://dev.api.trustlesswork.com", apiKey: "", platformAddress: fakeAddress() };
  await assert.rejects(() => deploy(baseDeployInput(), deps), EscrowConfigError);
});

test("an empty TRUSTLESS_WORK_PLATFORM_ADDRESS refuses deploy before any network access, even with every network stage overridden", async () => {
  const deps: Partial<EscrowCallDeps> = { platformAddress: "", ...unreachableStages() };
  await assert.rejects(() => deploy(baseDeployInput(), deps), EscrowConfigError);
});

test("an empty TRUSTLESS_WORK_PLATFORM_ADDRESS refuses resolveDispute before any network access", async () => {
  const deps: Partial<EscrowCallDeps> = { platformAddress: "", ...unreachableStages() };
  const input: ResolveDisputeInput = { contractId: "c", distributions: [{ address: fakeAddress(), amount: "1000000" }] };
  await assert.rejects(() => resolveDispute(input, deps), EscrowConfigError);
});

test("resolveDispute refuses an empty distributions list before any network access", async () => {
  const deps: Partial<EscrowCallDeps> = { platformAddress: fakeAddress(), ...unreachableStages() };
  await assert.rejects(() => resolveDispute({ contractId: "c", distributions: [] }, deps), EscrowConfigError);
});

test("resolveDispute refuses distributions that name the same address twice before any network access", async () => {
  const deps: Partial<EscrowCallDeps> = { platformAddress: fakeAddress(), ...unreachableStages() };
  const sameAddress = fakeAddress();
  const input: ResolveDisputeInput = {
    contractId: "c",
    distributions: [
      { address: sameAddress, amount: "3000000" },
      { address: sameAddress, amount: "7000000" },
    ],
  };
  await assert.rejects(() => resolveDispute(input, deps), EscrowConfigError);
});

test("a Trustless Work API refusal (Problem Details) is translated to a typed EscrowApiError naming the condition, never the raw body", async () => {
  const problem: ApiProblemDetails = {
    type: "https://trustlesswork.dev/errors/escrow-platform-fee-too-high",
    title: "Platform fee too high",
    status: 422,
    code: "ESCROW_PLATFORM_FEE_TOO_HIGH",
    detail: "platformFee must not exceed the configured maximum",
  };
  const deps: Partial<EscrowCallDeps> = {
    ...unreachableStages(),
    deployEscrow: async () => {
      throw new TrustlessWorkApiError(problem);
    },
  };
  await assert.rejects(() => deploy(baseDeployInput(), { platformAddress: fakeAddress(), ...deps }), (error: unknown) => {
    assert.ok(error instanceof EscrowApiError);
    assert.equal(error.code, "ESCROW_PLATFORM_FEE_TOO_HIGH");
    assert.equal(error.status, 422);
    assert.doesNotMatch(error.message, /trustlesswork\.dev\/errors/, "the raw Problem Details type/URL should not leak verbatim");
    return true;
  });
});

test("Trustless Work being unreachable (network/timeout) is translated to a typed EscrowRequestError, never a raw fetch error", async () => {
  const deps: Partial<EscrowCallDeps> = {
    ...unreachableStages(),
    fundEscrow: async () => {
      throw new TrustlessWorkNetworkError("fetch failed", 0, undefined);
    },
  };
  await assert.rejects(
    () => fund({ contractId: "c", clientAddress: fakeAddress(), amount: "1000000" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof EscrowRequestError);
      assert.ok(!(error instanceof TrustlessWorkNetworkError));
      return true;
    },
  );
});
