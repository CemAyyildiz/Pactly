import { useState } from "react";

import { ApiError } from "../api/client";
import {
  approveAppointment,
  buildBalancePayment,
  completeAppointment,
  markBalancePaidCash,
  openDispute,
  releaseDeposit,
  submitBalancePayment,
  submitSignedTransaction,
} from "../api/hooks";
import { LOCAL_CURRENCY_UNAVAILABLE_NOTE } from "../lib/money";
import { signXdr, type Session } from "../wallet";
import { useFormatTry } from "./TryAmount";
import type { ActionResponse, BalanceState, BookingLifecycle, DisputeReason, Money, PendingActionKind } from "../api/types";

export interface BookingActionsProps {
  viewer: "client" | "provider";
  id: string;
  escrowState: "locked" | "released" | "refunded" | null;
  lifecycle: BookingLifecycle;
  /** Story 3.6 (review round): while set, every action hides itself in
   * favor of a plain "waiting" notice -- a signed transaction for this
   * action kind has already been relayed and is awaiting chain
   * confirmation, so building another one here would only ever create a
   * second, redundant transaction (the backend refuses it outright,
   * `409 ACTION_PENDING`, but the UI should never let it get that far). */
  pendingAction?: PendingActionKind;
  deposit: Money;
  /** Story 3.7: the balance's own amount and state -- drives "Pay balance"
   * (client) and "Mark paid in person" (provider). The balance row's own
   * "View payment record" link lives in `BookingCard.tsx`/`BookingsPage
   * .tsx` instead of here (review follow-up: this component renders nothing
   * once the booking leaves `locked`, which is exactly when a settled
   * booking's own link would need to keep showing). */
  balance: Money;
  balanceState: BalanceState;
  /** UTC epoch seconds -- `null` for a pre-3.4 booking with no slot. Gates
   * "Pay balance": the spec's own "Always" rule, "only before the
   * appointment starts". */
  slotStartsAt: number | null;
  session?: Session;
  /** Called once an action's signed transaction has actually been relayed
   * (escrow actions), or once a balance action's own final outcome is
   * known -- the caller's own cue to refetch its list/view. May return the
   * refetch's own promise (review follow-up: "Pay balance" awaits it after
   * an ambiguous `PAYMENT_UNAVAILABLE` outcome, so it never re-enables
   * itself on stale data); a caller that returns nothing still works
   * exactly as before. */
  onActionSubmitted?: () => unknown;
  onUnauthorized?: () => void;
}

/** Story 3.6 (review round): each dispute reason is bound to whichever role
 * may actually claim it -- a client may claim that the client is
 * cancelling, that the provider did not show up, or a plain disagreement; a
 * provider's own three mirror that (the backend refuses any other
 * combination, `400 INVALID_REASON`). */
const DISPUTE_REASON_OPTIONS: Record<"client" | "provider", Array<{ value: DisputeReason; label: string }>> = {
  client: [
    { value: "client-cancel", label: "I'm cancelling" },
    { value: "provider-no-show", label: "The provider didn't show up" },
    { value: "disagreement", label: "We disagree about what happened" },
  ],
  provider: [
    { value: "provider-cancel", label: "I'm cancelling" },
    { value: "client-no-show", label: "The client didn't show up" },
    { value: "disagreement", label: "We disagree about what happened" },
  ],
};

/** EXPERIENCE.md's own "Cancelling and resolution" copy: the policy's own
 * words, stated before any signature is ever asked for, kept strictly
 * separate from what the chain has actually done. Never names "the clinic"
 * (implementation vocabulary never reaches users past its own domain, and
 * this product is vertical-agnostic besides) -- always "the provider", and
 * phrased from *this* viewer's own side ("to you" rather than "to the
 * client" when the viewer is the client, and symmetrically for the
 * provider). */
function policyStatement(suggestedOutcome: "refund-client" | "pay-provider" | undefined, depositLabel: string, viewer: "client" | "provider"): string {
  if (suggestedOutcome === "refund-client") {
    const recipient = viewer === "client" ? "you" : "the client";
    return `Your booking policy says this returns all ${depositLabel} to ${recipient}.`;
  }
  if (suggestedOutcome === "pay-provider") {
    const recipient = viewer === "provider" ? "you" : "the provider";
    return `Your booking policy says the full ${depositLabel} deposit goes to ${recipient}.`;
  }
  return "Your booking policy has no automatic outcome for a plain disagreement.";
}

type ActionKind = "complete" | "approve" | "release";

type DisputeStep =
  | { kind: "idle" }
  | { kind: "picking-reason" }
  | { kind: "confirming"; reason: DisputeReason; suggestedOutcome: "refund-client" | "pay-provider" | undefined; unsignedXdr: string };

/** Story 3.7's own balance actions -- kept distinct from `ActionKind` above
 * (escrow actions) since they hit an entirely separate pair of routes
 * (`/balance/pay`+`/balance/submit`, `/balance/mark-cash`), never the
 * escrow submit endpoint. `"confirming-balance"` is its own state (review
 * follow-up) rather than reusing `"pay-balance"` for the whole call: unlike
 * the escrow actions' own submit (a quick relay the reconciler confirms
 * later), `submitBalancePayment` itself polls to a final on-chain result,
 * which can take up to the built transaction's own 5-minute timeout --
 * "Confirm with your passkey…" would sit there, wrong, for all of it. */
type BalanceActionKind = "pay-balance" | "confirming-balance" | "mark-cash";

/**
 * The role-correct action buttons for one booking (Story 3.6): "Mark
 * appointment complete" (provider, from `funded` only), "Approve" (client,
 * from `funded` or `completed`), "Release deposit" (provider, from
 * `approved`), and "Open a dispute" (either side, from any pre-dispute
 * state) -- each reuses 3.4's own `signXdr` + `submitSignedTransaction`
 * pair. Shared by `BookingCard.tsx` (My bookings, and the panel's card view
 * below 1024px) and `BookingsPage.tsx`'s desktop table, so the
 * sign-and-submit flow for every action lives in exactly one place. No
 * action is ever shown once the lifecycle has reached `disputed`,
 * `released` or `resolved`, or while `pendingAction` is set. Story 3.7
 * adds "Pay balance" (client) and "Mark paid in person" (provider),
 * entirely separate routes from the escrow actions above (AD-3).
 */
export function BookingActions({
  viewer,
  id,
  escrowState,
  lifecycle,
  pendingAction,
  deposit,
  balance,
  balanceState,
  slotStartsAt,
  session,
  onActionSubmitted,
  onUnauthorized,
}: BookingActionsProps) {
  const [busyAction, setBusyAction] = useState<ActionKind | "dispute" | BalanceActionKind | undefined>(undefined);
  const [notice, setNotice] = useState<{ text: string; alert?: boolean } | undefined>(undefined);
  const [disputeStep, setDisputeStep] = useState<DisputeStep>({ kind: "idle" });
  const [confirmingCash, setConfirmingCash] = useState(false);
  /** Review follow-up (item 8): an ambiguous `PAYMENT_UNAVAILABLE` after the
   * client already signed means Pactly itself does not yet know whether the
   * payment landed -- "Pay balance" stays hidden/disabled until a refetch
   * of this booking confirms it is still `unpaid`, so the client can never
   * fire a second real payment while the first one's outcome is unknown. */
  const [verifyingBalance, setVerifyingBalance] = useState(false);
  const formatTryAmount = useFormatTry();

  function describeFailure(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.code === "BOOKING_STATE" || error.code === "ACTION_PENDING") {
        return "This booking has already moved on -- refresh to see its current state.";
      }
      if (error.code === "INVALID_REASON") {
        return "That reason isn't available for you to claim on this booking.";
      }
      if (error.code === "NOTHING_TO_PAY") {
        return "There's nothing to pay -- the balance is already zero.";
      }
      if (error.code === "PAYMENT_FAILED") {
        return "The payment could not be completed. The balance is still unpaid.";
      }
      if (error.code === "PAYMENT_UNAVAILABLE") {
        return "The payment network is unavailable right now. The balance is still unpaid -- try again shortly.";
      }
      if (error.code === "XDR_MISMATCH") {
        return "That transaction no longer matches -- refresh and try again.";
      }
      return error.message;
    }
    return "Connection dropped. Nothing changed.";
  }

  async function runAction(kind: ActionKind, build: () => Promise<ActionResponse>, successNotice: string): Promise<void> {
    if (!session || busyAction) return;
    setBusyAction(kind);
    setNotice(undefined);
    try {
      const built = await build();
      let signedXdr: string;
      try {
        signedXdr = await signXdr(built.unsignedXdr, session.walletAddress);
      } catch {
        setNotice({ text: "You didn't sign. Nothing changed -- try again whenever you're ready." });
        return;
      }
      await submitSignedTransaction(id, signedXdr, session);
      setNotice({ text: successNotice });
      onActionSubmitted?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized?.();
        return;
      }
      setNotice({ text: describeFailure(error), alert: true });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function confirmDispute(): Promise<void> {
    if (disputeStep.kind !== "confirming" || !session) return;
    setBusyAction("dispute");
    setNotice(undefined);
    try {
      let signedXdr: string;
      try {
        signedXdr = await signXdr(disputeStep.unsignedXdr, session.walletAddress);
      } catch {
        setNotice({ text: "You didn't sign. Nothing changed -- try again whenever you're ready." });
        return;
      }
      await submitSignedTransaction(id, signedXdr, session);
      setDisputeStep({ kind: "idle" });
      setNotice({ text: 'This needs resolution now. It reads "In resolution" until Pactly resolves it.' });
      onActionSubmitted?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized?.();
        return;
      }
      setNotice({ text: describeFailure(error), alert: true });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function pickDisputeReason(reason: DisputeReason): Promise<void> {
    if (!session) return;
    setBusyAction("dispute");
    setNotice(undefined);
    try {
      const result = await openDispute(id, reason, session);
      setDisputeStep({ kind: "confirming", reason, suggestedOutcome: result.suggestedOutcome, unsignedXdr: result.unsignedXdr });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized?.();
        return;
      }
      setNotice({ text: describeFailure(error), alert: true });
    } finally {
      setBusyAction(undefined);
    }
  }

  /**
   * "Pay balance" (client only): builds the unsigned payment, signs it, and
   * relays it through `/balance/submit` -- distinct from `runAction` above
   * since it hits a wholly separate pair of routes (AD-3: the balance
   * payment never touches the escrow submit endpoint), even though the
   * sign-then-submit shape is otherwise identical. The success notice reads
   * "Paid through Pactly" only once the ledger has actually confirmed
   * (`submitBalancePayment` itself polls to a final result before
   * resolving), never merely on submission. Split into two `try` blocks
   * (review follow-up) so only a failure *after* the signature returns --
   * build, and a declined signature, can never leave money in an unknown
   * state -- gets the ambiguous-outcome treatment below.
   */
  async function handlePayBalance(): Promise<void> {
    if (!session || busyAction) return;
    setBusyAction("pay-balance");
    setNotice(undefined);

    let unsignedXdr: string;
    try {
      ({ unsignedXdr } = await buildBalancePayment(id, session));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized?.();
      } else {
        setNotice({ text: describeFailure(error), alert: true });
      }
      setBusyAction(undefined);
      return;
    }

    let signedXdr: string;
    try {
      signedXdr = await signXdr(unsignedXdr, session.walletAddress);
    } catch {
      setNotice({ text: "You didn't sign. Nothing changed -- try again whenever you're ready." });
      setBusyAction(undefined);
      return;
    }

    // The signature is spent from here on -- "Confirm with your passkey…"
    // no longer applies; the wait is now for the ledger, not the wallet.
    setBusyAction("confirming-balance");
    try {
      await submitBalancePayment(id, signedXdr, session);
      setNotice({ text: "Paid through Pactly." });
      onActionSubmitted?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (error instanceof ApiError && error.code === "PAYMENT_UNAVAILABLE") {
        // Review follow-up (item 8): Pactly itself could not confirm
        // whether this landed -- never claim it failed (it might still
        // land) and never silently let the client try again on stale data.
        setNotice({
          text: "We couldn't confirm whether this payment went through. Checking your balance before you can try again…",
          alert: true,
        });
        setVerifyingBalance(true);
        try {
          await onActionSubmitted?.();
        } finally {
          setVerifyingBalance(false);
        }
        return;
      }
      setNotice({ text: describeFailure(error), alert: true });
    } finally {
      setBusyAction(undefined);
    }
  }

  /** "Mark paid in person" (provider only), behind its own confirm step
   * (the spec's own "Always" rule) -- no signature, no XDR: this is Pactly's
   * own record of a payment that already happened off-chain. */
  async function handleMarkCash(): Promise<void> {
    if (!session || busyAction) return;
    setBusyAction("mark-cash");
    setNotice(undefined);
    try {
      await markBalancePaidCash(id, session);
      setConfirmingCash(false);
      setNotice({ text: "Marked paid in person." });
      onActionSubmitted?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized?.();
        return;
      }
      setNotice({ text: describeFailure(error), alert: true });
    } finally {
      setBusyAction(undefined);
    }
  }

  const action = lifecycle.action;
  const isPending = Boolean(pendingAction);
  const canAct = Boolean(session) && escrowState === "locked" && !isPending;
  const canComplete = canAct && viewer === "provider" && action === "funded";
  const canApprove = canAct && viewer === "client" && (action === "funded" || action === "completed");
  const canRelease = canAct && viewer === "provider" && action === "approved";
  const canDispute = canAct && action !== "disputed" && action !== "released" && action !== "resolved";
  const hasBalanceToPay = balance.amount !== "0";
  const appointmentNotStarted = slotStartsAt === null || slotStartsAt > Math.floor(Date.now() / 1000);
  const canPayBalance = canAct && viewer === "client" && balanceState === "unpaid" && hasBalanceToPay && appointmentNotStarted && !verifyingBalance;
  const canMarkCash = canAct && viewer === "provider" && balanceState === "unpaid" && hasBalanceToPay;
  const isBusy = busyAction !== undefined;

  if (isPending) {
    return (
      <div className="booking-actions">
        <p className="booking-card__notice" aria-live="polite">
          Waiting for the network to confirm.
        </p>
      </div>
    );
  }

  if (
    !canComplete &&
    !canApprove &&
    !canRelease &&
    !canDispute &&
    !canPayBalance &&
    !canMarkCash &&
    !confirmingCash &&
    disputeStep.kind === "idle" &&
    !notice
  ) {
    return null;
  }

  return (
    <div className="booking-actions">
      {disputeStep.kind === "idle" && (canComplete || canApprove || canRelease || canDispute) && (
        <div className="booking-card__actions">
          {canComplete && (
            <button
              type="button"
              className="button-primary"
              disabled={isBusy}
              onClick={() => void runAction("complete", () => completeAppointment(id, session!), "Marked complete. Waiting for it to confirm.")}
            >
              {busyAction === "complete" ? "Confirm with your passkey…" : "Mark appointment complete"}
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              className="button-primary"
              disabled={isBusy}
              onClick={() => void runAction("approve", () => approveAppointment(id, session!), "Approved. Waiting for it to confirm.")}
            >
              {busyAction === "approve" ? "Confirm with your passkey…" : "Approve"}
            </button>
          )}
          {canRelease && (
            <button
              type="button"
              className="button-primary"
              disabled={isBusy}
              onClick={() => void runAction("release", () => releaseDeposit(id, session!), "Released. Waiting for it to confirm.")}
            >
              {busyAction === "release" ? "Confirm with your passkey…" : "Release deposit"}
            </button>
          )}
          {canDispute && (
            <button type="button" className="button-ghost" disabled={isBusy} onClick={() => setDisputeStep({ kind: "picking-reason" })}>
              Open a dispute
            </button>
          )}
        </div>
      )}

      {canPayBalance && !confirmingCash && disputeStep.kind === "idle" && (
        <div className="booking-card__balance-actions">
          <p className="booking-card__balance-note">{LOCAL_CURRENCY_UNAVAILABLE_NOTE}</p>
          <div className="booking-card__actions">
            <button type="button" className="button-primary" disabled={isBusy} onClick={() => void handlePayBalance()}>
              {busyAction === "pay-balance"
                ? "Confirm with your passkey…"
                : busyAction === "confirming-balance"
                  ? "Confirming…"
                  : `Pay balance (${formatTryAmount(balance.amount)})`}
            </button>
          </div>
        </div>
      )}

      {canMarkCash && !confirmingCash && disputeStep.kind === "idle" && (
        <div className="booking-card__actions">
          <button type="button" className="button-ghost" disabled={isBusy} onClick={() => setConfirmingCash(true)}>
            Mark paid in person
          </button>
        </div>
      )}

      {confirmingCash && (
        <div className="booking-card__dispute-panel">
          <p>Confirm this client already paid the {formatTryAmount(balance.amount)} balance in person.</p>
          <div className="booking-card__actions">
            <button type="button" className="button-primary" disabled={isBusy} onClick={() => void handleMarkCash()}>
              {busyAction === "mark-cash" ? "Saving…" : "Confirm, paid in person"}
            </button>
            <button type="button" className="button-ghost" disabled={isBusy} onClick={() => setConfirmingCash(false)}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {disputeStep.kind === "picking-reason" && (
        <div className="booking-card__dispute-panel">
          <p>What's this about?</p>
          <div className="booking-card__actions">
            {DISPUTE_REASON_OPTIONS[viewer].map((option) => (
              <button key={option.value} type="button" className="button-ghost" disabled={isBusy} onClick={() => void pickDisputeReason(option.value)}>
                {option.label}
              </button>
            ))}
            <button type="button" className="button-ghost" disabled={isBusy} onClick={() => setDisputeStep({ kind: "idle" })}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {disputeStep.kind === "confirming" && (
        <div className="booking-card__dispute-panel">
          <p>{policyStatement(disputeStep.suggestedOutcome, formatTryAmount(deposit.amount), viewer)}</p>
          <p>This needs resolution. Pactly will resolve it as the named dispute resolver -- nothing moves until then.</p>
          <div className="booking-card__actions">
            <button type="button" className="button-primary" disabled={isBusy} onClick={() => void confirmDispute()}>
              {busyAction === "dispute" ? "Confirm with your passkey…" : "Confirm and open dispute"}
            </button>
            <button type="button" className="button-ghost" disabled={isBusy} onClick={() => setDisputeStep({ kind: "idle" })}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p className={`booking-card__notice${notice.alert ? " booking-card__notice--alert" : ""}`} aria-live="polite">
          {notice.text}
        </p>
      )}
    </div>
  );
}
