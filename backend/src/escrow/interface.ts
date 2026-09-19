/**
 * The vendor-neutral escrow boundary AD-8 requires (Story 2.6). Every
 * caller outside `escrow/` -- today, only `services/booking.ts` -- depends
 * on this interface alone, never on a Trustless Work type, so a future
 * vendor swap only ever touches a new `escrow/<vendor>/` sibling to
 * `escrow/trustless-work/`.
 *
 * Every mutate method returns an *unsigned* XDR string (plus whatever
 * identifiers the caller needs to track the operation) -- this adapter
 * never holds or requests a private key, and never signs or submits
 * anything itself. That is also why no method below takes a `Keypair`:
 * unlike `chain/client.ts`, which builds, signs and submits its own
 * transaction end to end and so needs a real `Keypair` to call `.sign()`
 * with, nothing here ever calls `.sign()` -- Trustless Work's own API
 * builds the transaction and hands back unsigned XDR, so every method only
 * ever needs the *address* of whichever role is expected to eventually
 * sign it. Routing that XDR to the right wallet (or managed-account
 * signer) is the caller's job, not this adapter's.
 *
 * Amounts are integer strings in the asset's smallest unit (AD-7), exactly
 * as they are everywhere else in this backend -- the adapter implementation
 * (`trustless-work/client.ts`) is the one place that ever converts one to
 * Trustless Work's own human-decimal `number`, with an explicit range check
 * before the conversion.
 *
 * Cancellation, no-show and dispute resolution are never automatic here:
 * `resolveDispute` is the one method Pactly itself calls, signing as
 * Dispute Resolver, and it only ever runs on an explicit decision Pactly
 * makes -- never an outcome a deadline enforces on its own (Story 1.8
 * AC7). A doc comment or log message that touches any of these states must
 * say so plainly, per this story's own Boundaries & Constraints.
 */

/** Booking-level input for deploying a new escrow. `bookingId` becomes the
 * escrow's `engagementId` (AD-13) -- the join key a reconciler or a later
 * lookup uses to get back to this booking, never a vendor-assigned id. */
export interface DeployEscrowInput {
  bookingId: string;
  /** The client's Stellar account (G...) -- funder and approver, per the
   * role map (Story 1.8). */
  clientAddress: string;
  /** The professional's Stellar account (G...) -- service provider,
   * release signer (self-claim) and receiver, per the role map. */
  providerAddress: string;
  /** The deposit's token contract (the trustline's Soroban SAC id). */
  tokenAddress: string;
  /** The trustline's asset symbol (e.g. "USDC"). */
  assetSymbol: string;
  /** Integer string, smallest unit (AD-7). Must be a positive integer
   * that survives conversion to Trustless Work's own `number` amount
   * (see the adapter's own conversion note) -- refused before any network
   * access otherwise. */
  amount: string;
  title: string;
  description: string;
}

export interface DeployEscrowResult {
  /** The escrow's predicted Soroban contract id -- returned by Trustless
   * Work's own build step, before the deploy transaction is ever signed or
   * submitted. */
  contractId: string;
  unsignedXdr: string;
  txHash: string;
}

/** The shape every non-deploy mutate method returns: an unsigned
 * transaction ready for the assigned role's signature. */
export interface UnsignedTransaction {
  unsignedXdr: string;
  txHash: string;
}

export interface FundEscrowInput {
  contractId: string;
  /** The client's own address -- funding is always the funder's own
   * signature, per the role map. */
  clientAddress: string;
  /** Integer string, smallest unit (AD-7). */
  amount: string;
}

export interface ApproveEscrowInput {
  contractId: string;
  /** The client's own address -- approval is always the approver's own
   * signature, per the role map. */
  clientAddress: string;
}

export interface ReleaseEscrowInput {
  contractId: string;
  /** The provider's own address -- release signer and receiver are the
   * same party (self-claim), per the role map. */
  providerAddress: string;
}

export interface StartDisputeInput {
  contractId: string;
  /** Whoever raises the dispute -- the client (as approver) or the
   * provider (as service provider); never Pactly itself, which only ever
   * signs the later `resolveDispute` call. */
  signerAddress: string;
  reason: string;
}

export interface ResolveDisputeDistribution {
  address: string;
  /** Integer string, smallest unit (AD-7). */
  amount: string;
}

export interface ResolveDisputeInput {
  contractId: string;
  /** Named addresses and amounts -- an explicit allocation Pactly itself
   * decides, never inferred from a deadline. */
  distributions: ResolveDisputeDistribution[];
}

export interface SubmitTransactionResult {
  txHash: string;
}

export interface EscrowAdapter {
  deploy(input: DeployEscrowInput): Promise<DeployEscrowResult>;
  fund(input: FundEscrowInput): Promise<UnsignedTransaction>;
  approve(input: ApproveEscrowInput): Promise<UnsignedTransaction>;
  release(input: ReleaseEscrowInput): Promise<UnsignedTransaction>;
  startDispute(input: StartDisputeInput): Promise<UnsignedTransaction>;
  /** Pactly resolves a dispute explicitly, signing as Dispute Resolver --
   * see this interface's own top-level doc comment. Never called as a
   * side effect of a deadline passing. */
  resolveDispute(input: ResolveDisputeInput): Promise<UnsignedTransaction>;
  /**
   * Story 3.4: submits a transaction the caller's own wallet has already
   * signed (any of the unsigned XDRs the five methods above returned) over
   * Trustless Work's own `POST /stellar/send-transaction` -- this backend
   * never holds a private key, so this is the one method that ever crosses
   * from "unsigned" to "on chain", and it does so with a transaction this
   * adapter never built itself, only relayed. `escrow_state` still never
   * moves here (AD-1): only the reconciler, reading confirmed evidence
   * back out of Trustless Work's own read model, ever writes it -- this
   * method's own successful return is not itself that evidence.
   */
  submit(signedXdr: string): Promise<SubmitTransactionResult>;
}
