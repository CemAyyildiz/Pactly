/**
 * `chain/events.ts`'s wire decoding, tested as a unit -- no RPC call
 * anywhere. `decodeEvent` is the only code that turns a raw RPC
 * `EventResponse` into the `ChainEvent` the worker consumes, and it had no
 * coverage: every event-worker test builds a `ChainEvent` by hand, never
 * through this function. Fixtures use real `ScVal`s (`nativeToScVal`), the
 * same encoding the real contract's events use, so a mistake like reading
 * the event name from the booking-id topic slot (or vice versa) fails.
 */
import "./testConfigEnv.js";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";

import { decodeEvent, realFetchEvents } from "../src/chain/events.js";
import { ChainConfigError } from "../src/chain/errors.js";
import { config } from "../src/config.js";

function fakeEventResponse(options: {
  eventName: string;
  bookingIdHex: string;
  amount: bigint;
  id?: string;
  ledger?: number;
}): rpc.Api.EventResponse {
  return {
    id: options.id ?? "0000000042-0000000001",
    type: "contract",
    ledger: options.ledger ?? 42,
    ledgerClosedAt: new Date(0).toISOString(),
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: "a".repeat(64),
    topic: [
      nativeToScVal(options.eventName, { type: "symbol" }),
      nativeToScVal(Uint8Array.from(Buffer.from(options.bookingIdHex, "hex")), { type: "bytes" }),
    ],
    value: nativeToScVal(options.amount, { type: "i128" }),
  };
}

test("decodeEvent decodes a real event: name from topic[0], booking id from topic[1], amount from value", () => {
  const bookingIdHex = randomBytes(16).toString("hex");
  const raw = fakeEventResponse({ eventName: "locked", bookingIdHex, amount: 1234567890n, id: "evt-1", ledger: 55 });
  const decoded = decodeEvent(raw);
  assert.deepEqual(decoded, {
    id: "evt-1",
    ledger: 55,
    bookingId: bookingIdHex,
    eventType: "locked",
    amount: "1234567890",
  });
});

test("decodeEvent does not swap topic[0] and topic[1]: the booking id it returns is topic[1]'s, not topic[0]'s", () => {
  const bookingIdHex = randomBytes(16).toString("hex");
  const raw = fakeEventResponse({ eventName: "released", bookingIdHex, amount: 1n });
  const decoded = decodeEvent(raw);
  assert.equal(decoded?.eventType, "released");
  assert.equal(decoded?.bookingId, bookingIdHex);
  // A topic swap would make topic[0] the (non-symbol) booking-id bytes,
  // which isEventName rejects -- so decodeEvent would return undefined
  // instead of a mismatched pair. Assert the positive case explicitly:
  // the decoded bookingId must come from topic[1], not equal the event name.
  assert.notEqual(decoded?.bookingId, decoded?.eventType);
});

test("decodeEvent round-trips an i128-max amount as an identical string", () => {
  const bookingIdHex = randomBytes(16).toString("hex");
  const raw = fakeEventResponse({
    eventName: "forfeited",
    bookingIdHex,
    amount: 170141183460469231731687303715884105727n,
  });
  const decoded = decodeEvent(raw);
  assert.equal(decoded?.amount, "170141183460469231731687303715884105727");
  assert.equal(decoded?.eventType, "forfeited");
});

test("decodeEvent drops an event whose topic[0] is not one of the five recognized names, rather than throwing", () => {
  const bookingIdHex = randomBytes(16).toString("hex");
  const raw = fakeEventResponse({ eventName: "not_a_real_event", bookingIdHex, amount: 1n });
  assert.equal(decodeEvent(raw), undefined);
});

test("realFetchEvents refuses before constructing the RPC server when ESCROW_CONTRACT_ID is empty", () => {
  const original = config.escrowContractId;
  config.escrowContractId = "";
  try {
    assert.throws(() => realFetchEvents(), ChainConfigError);
  } finally {
    config.escrowContractId = original;
  }
});
