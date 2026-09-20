import type { ReactNode } from "react";

import { EscrowProof } from "./EscrowProof";
import { TryAmount } from "./TryAmount";

export interface EscrowLaneProps {
  /** Integer string, USDC smallest units (AD-7) -- shown in TRY. */
  depositAmount: string;
  /** `undefined` before a hold exists. */
  holdCountdownLabel?: string;
  contractId?: string;
  txHash?: string;
  /** Review follow-up: the escrow proof line is evidence for a *confirmed*
   * lock, not a preview of a deploy still in flight -- callers pass `true`
   * only once the booking has actually reconciled to `locked`, never
   * merely because a `contractId` happens to exist yet (a deploy can be
   * built, or even abandoned and rebuilt, long before that). */
  showProof: boolean;
  /** A short, plain-language state label -- text always accompanies the
   * lane's colour (DESIGN.md Accessibility Floor: "state never conveyed by
   * colour alone"). */
  stateLabel: string;
  children?: ReactNode;
}

/**
 * DESIGN.md's `band-escrow`: the black column between the client and
 * provider lanes (or, below 1024px, the bar pinned to the bottom -- see
 * `base.css`'s own responsive rule). Holds the lock icon, the deposit
 * amount, the hold countdown while one is running, and the escrow proof
 * once the booking is actually locked. Never itself interactive except for
 * the "Lock with Pactly" button, which `BookingPage.tsx` passes in as
 * `children` so this component stays a pure display of state.
 */
export function EscrowLane({ depositAmount, holdCountdownLabel, contractId, txHash, showProof, stateLabel, children }: EscrowLaneProps) {
  return (
    <div className="escrow-lane">
      <p className="escrow-lane__label">ESCROW LANE</p>
      <div className="escrow-lane__lock" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </div>
      <div className="escrow-lane__amount tabular-nums">
        <TryAmount amount={depositAmount} />
      </div>
      <p className="escrow-lane__state" aria-live="polite">
        {stateLabel}
      </p>
      {holdCountdownLabel && (
        <p className="escrow-lane__countdown tabular-nums" aria-live="polite">
          Slot held for {holdCountdownLabel}
        </p>
      )}
      {children}
      {showProof && (contractId || txHash) && <EscrowProof contractId={contractId} txHash={txHash} />}
    </div>
  );
}
