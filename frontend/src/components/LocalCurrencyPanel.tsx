import { useState } from "react";

import { ApiError } from "../api/client";
import type { LocalDepositView } from "../api/types";

export interface LocalCurrencyPanelProps {
  deposit: LocalDepositView;
  busy: boolean;
  onSimulate: () => void;
  onUseWallet: () => void;
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
 * action. SEP vocabulary never appears (NFR9).
 */
export function LocalCurrencyPanel({ deposit, busy, onSimulate, onUseWallet }: LocalCurrencyPanelProps) {
  const { bankDetails } = deposit;
  return (
    <div className="local-deposit">
      <p className="local-deposit__status" aria-live="polite">
        {deposit.statusLabel}
        {deposit.stale ? " · last known status" : ""}
      </p>
      {(bankDetails.iban || bankDetails.reference || bankDetails.organization) && (
        <dl className="local-deposit__details">
          {bankDetails.organization && (
            <>
              <dt>Bank</dt>
              <dd>{bankDetails.organization}</dd>
            </>
          )}
          {bankDetails.iban && <CopyRow label="IBAN" value={bankDetails.iban} />}
          {bankDetails.reference && <CopyRow label="Reference" value={bankDetails.reference} />}
        </dl>
      )}
      {deposit.status === "failed" && (
        <p className="local-deposit__reason" role="alert">
          {deposit.reason ?? "The transfer did not go through. You can try again or pay with your wallet."}
        </p>
      )}
      {deposit.status === "waiting" && (
        <p className="local-deposit__how">This is a sandbox bank. Confirm the TRY send below — no real transfer is made.</p>
      )}
      {deposit.status === "paying" && (
        <p className="local-deposit__how">
          TRY is in. The sandbox still has not sent USDC to your wallet. Lock with wallet USDC instead of waiting.
        </p>
      )}
      {deposit.sandbox && deposit.status === "waiting" && (
        <button type="button" className="button-primary" disabled={busy} onClick={onSimulate}>
          {busy ? "Confirming…" : "Confirm TRY sent"}
        </button>
      )}
      {(deposit.status === "paying" || deposit.status === "failed" || deposit.status === "waiting") && (
        <button type="button" className="button-ghost" disabled={busy} onClick={onUseWallet}>
          Lock with wallet USDC instead
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
        return `This amount is outside the ${details.min}–${details.max} ${details.currency} range. Pay with your wallet instead.`;
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
