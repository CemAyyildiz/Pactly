import { useEffect, useState } from "react";

export interface LockButtonProps {
  /** `undefined` when idle (ready to tap); the human action name while
   * waiting on a signature -- "Create your escrow", "Lock your deposit"
   * (EXPERIENCE.md: "Each request explains the human action ... not the
   * transaction primitive"). */
  waitingOn?: string;
  disabled?: boolean;
  onClick: () => void;
  /** Fires when the user taps "Open wallet again" after the 60s timeout --
   * re-runs the same signature request. */
  onOpenWalletAgain?: () => void;
}

const OPEN_WALLET_AGAIN_AFTER_MS = 60_000;

/**
 * DESIGN.md's `button-escrow`: the only black button in the product, used
 * solely to lock a deposit. While waiting on a signature it reads "Approve
 * it in your wallet" (never a generic "Loading…"), and after 60 seconds an
 * "Open wallet again" option appears (EXPERIENCE.md's "Waiting on wallet"
 * state pattern) in case the wallet's own popup was dismissed or lost
 * focus.
 */
export function LockButton({ waitingOn, disabled, onClick, onOpenWalletAgain }: LockButtonProps) {
  const [showOpenAgain, setShowOpenAgain] = useState(false);

  useEffect(() => {
    if (!waitingOn) {
      setShowOpenAgain(false);
      return;
    }
    const timer = setTimeout(() => setShowOpenAgain(true), OPEN_WALLET_AGAIN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waitingOn]);

  return (
    <div className="lock-button-group">
      <button type="button" className="button-escrow" disabled={disabled || Boolean(waitingOn)} onClick={onClick} aria-live="polite">
        {waitingOn ? "Approve it in your wallet" : "Lock with Pactly"}
      </button>
      {waitingOn && <p className="lock-button-group__hint">{waitingOn}</p>}
      {waitingOn && showOpenAgain && (
        <button type="button" className="button-ghost lock-button-group__retry" onClick={onOpenWalletAgain}>
          Open wallet again
        </button>
      )}
    </div>
  );
}
