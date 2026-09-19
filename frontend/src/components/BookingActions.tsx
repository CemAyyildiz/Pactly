import { useState } from "react";

import { ApiError } from "../api/client";
import { approveAppointment, completeAppointment, openDispute, releaseDeposit, submitSignedTransaction } from "../api/hooks";
import { formatMoney } from "../lib/money";
import { signXdr, type Session } from "../wallet";
import type { ActionResponse, BookingLifecycle, DisputeReason, Money, PendingActionKind } from "../api/types";

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
  session?: Session;
  onActionSubmitted?: () => void;
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
 * `released` or `resolved`, or while `pendingAction` is set.
 */
export function BookingActions({ viewer, id, escrowState, lifecycle, pendingAction, deposit, session, onActionSubmitted, onUnauthorized }: BookingActionsProps) {
  const [busyAction, setBusyAction] = useState<ActionKind | "dispute" | undefined>(undefined);
  const [notice, setNotice] = useState<{ text: string; alert?: boolean } | undefined>(undefined);
  const [disputeStep, setDisputeStep] = useState<DisputeStep>({ kind: "idle" });

  function describeFailure(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.code === "BOOKING_STATE" || error.code === "ACTION_PENDING") {
        return "This booking has already moved on -- refresh to see its current state.";
      }
      if (error.code === "INVALID_REASON") {
        return "That reason isn't available for you to claim on this booking.";
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

  const action = lifecycle.action;
  const isPending = Boolean(pendingAction);
  const canAct = Boolean(session) && escrowState === "locked" && !isPending;
  const canComplete = canAct && viewer === "provider" && action === "funded";
  const canApprove = canAct && viewer === "client" && (action === "funded" || action === "completed");
  const canRelease = canAct && viewer === "provider" && action === "approved";
  const canDispute = canAct && action !== "disputed" && action !== "released" && action !== "resolved";
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

  if (!canComplete && !canApprove && !canRelease && !canDispute && disputeStep.kind === "idle" && !notice) {
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
              onClick={() => void runAction("complete", () => completeAppointment(id, session!), "Marked complete. Waiting for it to confirm on chain.")}
            >
              {busyAction === "complete" ? "Approve it in your wallet…" : "Mark appointment complete"}
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              className="button-primary"
              disabled={isBusy}
              onClick={() => void runAction("approve", () => approveAppointment(id, session!), "Approved. Waiting for it to confirm on chain.")}
            >
              {busyAction === "approve" ? "Approve it in your wallet…" : "Approve"}
            </button>
          )}
          {canRelease && (
            <button
              type="button"
              className="button-primary"
              disabled={isBusy}
              onClick={() => void runAction("release", () => releaseDeposit(id, session!), "Released. Waiting for it to confirm on chain.")}
            >
              {busyAction === "release" ? "Approve it in your wallet…" : "Release deposit"}
            </button>
          )}
          {canDispute && (
            <button type="button" className="button-ghost" disabled={isBusy} onClick={() => setDisputeStep({ kind: "picking-reason" })}>
              Open a dispute
            </button>
          )}
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
          <p>{policyStatement(disputeStep.suggestedOutcome, formatMoney(deposit.amount, deposit.asset), viewer)}</p>
          <p>This needs resolution. Pactly will resolve it as the named dispute resolver -- nothing moves until then.</p>
          <div className="booking-card__actions">
            <button type="button" className="button-primary" disabled={isBusy} onClick={() => void confirmDispute()}>
              {busyAction === "dispute" ? "Approve it in your wallet…" : "Sign and open dispute"}
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
