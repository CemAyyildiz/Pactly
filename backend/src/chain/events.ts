/**
 * Reads and decodes the escrow contract's money events off the Soroban RPC
 * `getEvents` method. This is the only module that knows the wire shape
 * `contracts/escrow/src/events.rs` promises -- topics `(name, booking_id)`,
 * data `amount` -- so `event-worker.ts` never touches an `ScVal`.
 */
import { rpc, scValToNative } from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { ChainConfigError } from "./errors.js";

/** The five, and only five, names the contract ever emits. */
export const EVENT_NAMES = ["locked", "released", "refunded", "cancelled", "forfeited"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

/** One decoded contract event, already stripped of `ScVal` -- `bookingId`
 * as the 32-hex-character shape `db/schema.ts` stores, `amount` as an
 * integer string (AD-7), never a `number` or a float. */
export interface ChainEvent {
  /** The RPC event's own id -- opaque, kept for traceability only; the
   * dedupe key is `(bookingId, eventType)`, not this. */
  id: string;
  ledger: number;
  bookingId: string;
  eventType: EventName;
  amount: string;
}

export interface FetchEventsResult {
  events: ChainEvent[];
  /** Always present, even for an empty batch -- `getEvents` advances the
   * retention window's cursor regardless of whether anything matched. */
  cursor: string;
}

/** The event worker's one seam onto the network: given the last processed
 * cursor (`undefined` on a first run), returns the next batch and the
 * cursor to resume from. Defaults to the real RPC call. */
export type FetchEvents = (cursor: string | undefined) => Promise<FetchEventsResult>;

/** Exported so `decodeEvent` -- the only code that turns a raw RPC event
 * into the `ChainEvent` the worker consumes -- can be unit-tested on its
 * own, with hand-built `ScVal`s, never a real RPC round trip. */
export function decodeEvent(raw: rpc.Api.EventResponse): ChainEvent | undefined {
  const name = scValToNative(raw.topic[0] as NonNullable<(typeof raw.topic)[0]>);
  if (!isEventName(name)) {
    // Defensive only: the contract's own `events.rs` promises exactly
    // these five topic names, but a consumer should never crash on a
    // topic it does not recognize.
    return undefined;
  }
  const bookingIdBytes = scValToNative(raw.topic[1] as NonNullable<(typeof raw.topic)[1]>) as Uint8Array;
  const amount = scValToNative(raw.value) as bigint;
  return {
    id: raw.id,
    ledger: raw.ledger,
    bookingId: Buffer.from(bookingIdBytes).toString("hex"),
    eventType: name,
    amount: amount.toString(),
  };
}

/**
 * The real implementation: pages `getEvents` for `contractId`'s events,
 * starting from `cursor` when given, or `startLedger` on a first run.
 *
 * `startLedger` has no configured source yet -- the contract is not
 * deployed, so no deployment ledger exists to seed it with. A later story
 * (once `ESCROW_CONTRACT_ID` is real) supplies the ledger the contract was
 * deployed at; until then this exists so the shape is right; it is never
 * called by anything in this story's own tests.
 */
export function defaultFetchEvents(
  server: rpc.Server,
  contractId: string,
  startLedger = 0,
  limit = 100,
): FetchEvents {
  return async (cursor) => {
    const request: rpc.Api.GetEventsRequest = cursor
      ? { filters: [{ type: "contract", contractIds: [contractId] }], cursor, limit }
      : { filters: [{ type: "contract", contractIds: [contractId] }], startLedger, limit };
    const response = await server.getEvents(request);
    const events: ChainEvent[] = [];
    for (const raw of response.events) {
      const decoded = decodeEvent(raw);
      if (decoded) events.push(decoded);
    }
    return { events, cursor: response.cursor };
  };
}

/** `fetchEvents` bound to `config`'s RPC url and contract id -- what the
 * real process wires the event worker to. Never constructed by a test. */
export function realFetchEvents(): FetchEvents {
  if (!config.escrowContractId) {
    // Refuse before constructing the RPC server -- that itself makes no
    // network call, but should not be reached either, for the same reason
    // `chain/client.ts`'s `invoke` refuses before its own network stages:
    // name the setup step instead of failing deeper in, against a
    // contract id that was never configured.
    throw new ChainConfigError(
      "ESCROW_CONTRACT_ID is empty. Deploy the escrow contract and set ESCROW_CONTRACT_ID " +
        "before starting the event worker (see `npm run setup:testnet`).",
    );
  }
  const server = new rpc.Server(config.sorobanRpcUrl);
  return defaultFetchEvents(server, config.escrowContractId);
}
