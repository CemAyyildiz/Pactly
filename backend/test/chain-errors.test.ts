/**
 * `chain/errors.ts`'s pure helpers, tested on their own (in addition to,
 * never instead of, `chain-client.test.ts`'s coverage of the same
 * translation exercised through the client as a unit). Fixtures mirror the
 * real shape a Soroban host error message takes -- as returned by
 * `simulateTransaction`'s `error` field -- for a few of the nine conditions
 * `contracts/escrow/src/error.rs` declares (discriminants 1-9, unchanged
 * since that file promises never to renumber them).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChainContractError,
  ChainRequestError,
  parseContractErrorCode,
  translateHostErrorMessage,
} from "../src/chain/errors.js";

/** A realistic simulateTransaction error string: the host wraps the
 * contract's own error code in this shape, followed by a diagnostic event
 * log Soroban always attaches. */
function hostErrorMessage(code: number): string {
  return (
    `HostError: Error(Contract, #${code})\n\n` +
    "Event log (newest first):\n" +
    "   0: [Diagnostic Event] contract_call, topics:[error, Error(Contract, " +
    `#${code})], data:"escrow: rejected"\n` +
    "   1: [Contract Fn] invoking escrow contract\n"
  );
}

test("parseContractErrorCode pulls the numeric code out of a realistic host error string", () => {
  assert.equal(parseContractErrorCode(hostErrorMessage(6)), 6);
  assert.equal(parseContractErrorCode(hostErrorMessage(9)), 9);
});

test("parseContractErrorCode returns undefined when the message names no contract error", () => {
  assert.equal(parseContractErrorCode("HostError: Error(WasmVm, InvalidAction)"), undefined);
  assert.equal(parseContractErrorCode("connect ECONNREFUSED 127.0.0.1:8000"), undefined);
});

test("translateHostErrorMessage maps error.rs discriminant 6 (InvalidState)", () => {
  const error = translateHostErrorMessage(hostErrorMessage(6));
  assert.ok(error instanceof ChainContractError);
  assert.equal(error.condition, "InvalidState");
});

test("translateHostErrorMessage maps error.rs discriminant 4 (BookingNotFound)", () => {
  const error = translateHostErrorMessage(hostErrorMessage(4));
  assert.ok(error instanceof ChainContractError);
  assert.equal(error.condition, "BookingNotFound");
});

test("translateHostErrorMessage maps error.rs discriminant 9 (TooEarly)", () => {
  const error = translateHostErrorMessage(hostErrorMessage(9));
  assert.ok(error instanceof ChainContractError);
  assert.equal(error.condition, "TooEarly");
});

test("translateHostErrorMessage maps error.rs discriminant 8 (InvalidParties)", () => {
  const error = translateHostErrorMessage(hostErrorMessage(8));
  assert.ok(error instanceof ChainContractError);
  assert.equal(error.condition, "InvalidParties");
});

test("translateHostErrorMessage returns a ChainRequestError for an unrecognized contract error code", () => {
  const error = translateHostErrorMessage(hostErrorMessage(42));
  assert.ok(error instanceof ChainRequestError);
  assert.ok(!(error instanceof ChainContractError));
});

test("translateHostErrorMessage returns a ChainRequestError for a non-contract host failure", () => {
  const error = translateHostErrorMessage("HostError: Error(WasmVm, InvalidAction): host invocation failed");
  assert.ok(error instanceof ChainRequestError);
});

test("ChainContractError's message names the condition, never the bare numeric code", () => {
  const error = translateHostErrorMessage(hostErrorMessage(6));
  assert.ok(error instanceof ChainContractError);
  assert.match(error.message, /InvalidState/);
  assert.doesNotMatch(error.message, /#6/);
});
