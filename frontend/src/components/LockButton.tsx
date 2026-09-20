import { useEffect, useState } from "react";

export interface LockButtonProps {
  /** `undefined` when idle (ready to tap); the human action name while
   * waiting on a signature -- "Create your escrow", "Lock your deposit"
   * (EXPERIENCE.md: "Each request explains the human action ... not the
   * transaction primitive"). */
  waitingOn?: string;
  disabled?: boolean;
  onClick: () => void;
  /** Fires when the user taps "Try again" after the 60s timeout --
   * re-runs the same signature request. Kept under its historical name so
   * every caller keeps compiling. */
  onOpenWalletAgain?: () => void;
}

const TRY_AGAIN_AFTER_MS = 60_000;

/**
 * DESIGN.md's `button-escrow`: the only black button in the product, used
 * solely to lock a deposit. While the deposit is being signed and sent it
 * reads "Locking…" (never a generic "Loading…") with the human action name
 * beneath it, and after 60 seconds a "Try again" option appears
 * (EXPERIENCE.md's waiting-state pattern) in case the request was lost on
 * the way. Signing happens server-side now -- there is no prompt for the
 * user to find and approve.
 */
export function LockButton({ waitingOn, disabled, onClick, onOpenWalletAgain }: LockButtonProps) {
  const [showTryAgain, setShowTryAgain] = useState(false);

  useEffect(() => {
    if (!waitingOn) {
      setShowTryAgain(false);
      return;
    }
    const timer = setTimeout(() => setShowTryAgain(true), TRY_AGAIN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waitingOn]);

  return (
    <div className="lock-button-group">
      <button type="button" className="button-escrow" disabled={disabled || Boolean(waitingOn)} onClick={onClick} aria-live="polite">
        {waitingOn ? "Locking…" : "Lock with Pactly"}
      </button>
      {waitingOn && <p className="lock-button-group__hint">{waitingOn}</p>}
      {waitingOn && showTryAgain && (
        <button type="button" className="button-ghost lock-button-group__retry" onClick={onOpenWalletAgain}>
          Try again
        </button>
      )}
    </div>
  );
}
