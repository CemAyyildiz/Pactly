import { useState } from "react";

import { ApiError } from "../api/client";
import type { LocalDepositView } from "../api/types";
import { TryAmount } from "./TryAmount";

export interface LocalCurrencyPanelProps {
  deposit: LocalDepositView;
  /** Integer string, USDC smallest units (AD-7) -- the deposit the transfer
   * has to cover, shown in TRY beside the bank details. */
  amount: string;
  busy: boolean;
  onSimulate: () => void;
  /** After a failed transfer: open a fresh one. */
  onRetry: () => void;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="tabular-nums">{value}</span>
        <button
          type="button"
          className="copy-chip"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
    </>
  );
}

/**
 * Story 2.4: bank details, waiting copy, and the sandbox-only confirm
 * action. The bank transfer is the only way to pay the deposit (2026-09
 * pivot), so this panel never offers another rail. SEP vocabulary never
 * appears (NFR9); neither does the escrow asset.
 */
export function LocalCurrencyPanel({ deposit, amount, busy, onSimulate, onRetry }: LocalCurrencyPanelProps) {
  const { bankDetails } = deposit;
  return (
    <div className="local-deposit">
      <p className="local-deposit__status" aria-live="polite">
        {deposit.statusLabel}
        {deposit.stale ? " · last known status" : ""}
      </p>
      <dl className="local-deposit__details">
        <dt>Amount</dt>
        <dd>
          <TryAmount amount={amount} />
        </dd>
        {bankDetails.organization && (
          <>
            <dt>Bank</dt>
            <dd>{bankDetails.organization}</dd>
          </>
        )}
        {bankDetails.iban && <CopyRow label="IBAN" value={bankDetails.iban} />}
        {bankDetails.reference && <CopyRow label="Reference" value={bankDetails.reference} />}
      </dl>
      {deposit.status === "failed" && (
        <p className="local-deposit__reason" role="alert">
          {deposit.reason ?? "The transfer did not go through. Nothing was taken -- try again."}
        </p>
      )}
      {deposit.status === "waiting" && (
        <p className="local-deposit__how">This is a sandbox bank. Confirm the TRY send below — no real transfer is made.</p>
      )}
      {deposit.status === "paying" && (
        <p className="local-deposit__how">Your transfer is in. Pactly is confirming it — this usually takes a moment.</p>
      )}
      {deposit.sandbox && deposit.status === "waiting" && (
        <button type="button" className="button-primary" disabled={busy} onClick={onSimulate}>
          {busy ? "Confirming…" : "Confirm TRY sent"}
        </button>
      )}
      {deposit.status === "failed" && (
        <button type="button" className="button-ghost" disabled={busy} onClick={onRetry}>
          {busy ? "Opening the transfer…" : "Try the transfer again"}
        </button>
      )}
    </div>
  );
}

export function localDepositErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "AMOUNT_OUT_OF_RANGE") {
      const details = error.details as { min?: string; max?: string; currency?: string } | undefined;
      if (details?.min && details.max && details.currency) {
        return `This deposit is outside the ${details.min}–${details.max} ${details.currency} range a bank transfer can carry.`;
      }
      return error.message;
    }
    if (error.code === "HOLD_EXPIRED") {
      return "This hold has expired. The slot may already be taken again.";
    }
    if (error.status === 401) {
      return "unauthorized";
    }
    return error.message;
  }
  return "Connection dropped. Your deposit is untouched.";
}
