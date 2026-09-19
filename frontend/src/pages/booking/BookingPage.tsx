import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import {
  fundDepositWithRetry,
  lockDeposit,
  submitSignedTransaction,
  useBooking,
  useHoldSlot,
  usePublicProviderProfile,
} from "../../api/hooks";
import { ApiError } from "../../api/client";
import type { HoldSlotResponse } from "../../api/types";
import { DepositPill } from "../../components/DepositPill";
import { EscrowLane } from "../../components/EscrowLane";
import { LockButton } from "../../components/LockButton";
import { ProviderHeader } from "../../components/ProviderHeader";
import { Seal } from "../../components/Seal";
import { formatMoney } from "../../lib/money";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { getSession, signIn, signXdr, type Session } from "../../wallet";

/** The multi-step "Lock with Pactly" sequence's own resumable phase --
 * distinct from `holdStatus` below, which only covers getting the hold
 * itself. A wallet rejection at any signing step moves this back to a
 * resumable point (`idle` before a deploy exists, `deployed` once one
 * does) rather than failing the whole flow (spec: "Lock can be retried"). */
type LockPhase =
  | { kind: "idle" }
  | { kind: "deploying" }
  | { kind: "awaiting-deploy-signature" }
  | { kind: "submitting-deploy" }
  | { kind: "deployed"; contractId: string }
  | { kind: "funding"; contractId: string }
  | { kind: "awaiting-fund-signature"; contractId: string }
  | { kind: "submitting-fund"; contractId: string }
  | { kind: "reconciling"; contractId: string; txHash: string }
  | { kind: "locked"; contractId: string; txHash: string };

const SESSION_FORMAT_LABEL: Record<string, string> = {
  video: "Video call",
  in_person: "In person",
};

function formatDeadline(epochSeconds: number): string {
  return `${formatSlotDay(epochSeconds)} · ${formatSlotTime(epochSeconds)}`;
}

/**
 * `/book/:providerId?slot=<epochSeconds>` -- the Story 3.4 booking screen.
 * Steps (Tasks & Acceptance): review summary; connect wallet and hold;
 * Lock with Pactly (lock -> sign -> submit -> fund -> sign -> submit); poll
 * `GET /bookings/:id` until `locked`; seal. The wallet is requested only
 * once the client actually commits to holding the slot (EXPERIENCE.md:
 * "wallet requested only at payment").
 */
export function BookingPage() {
  const { providerId } = useParams<{ providerId: string }>();
  const [searchParams] = useSearchParams();
  const slotParam = searchParams.get("slot");
  const slotStartsAt = slotParam ? Number(slotParam) : undefined;

  const { data: profile, isLoading: profileLoading, error: profileError } = usePublicProviderProfile(providerId);

  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [connecting, setConnecting] = useState(false);
  const [holdError, setHoldError] = useState<{ message: string; sameDaySlots?: number[] } | undefined>();
  const [hold, setHold] = useState<HoldSlotResponse | undefined>();
  const [holdSecondsLeft, setHoldSecondsLeft] = useState<number | undefined>();

  const holdMutation = useHoldSlot(session);

  const [phase, setPhase] = useState<LockPhase>({ kind: "idle" });
  const [flowNotice, setFlowNotice] = useState<string | undefined>();
  const [flowFatalError, setFlowFatalError] = useState<string | undefined>();

  const booking = useBooking(hold?.bookingId, session, {
    enabled: phase.kind === "reconciling" || phase.kind === "locked",
  });

  const prefersReducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // The hold countdown, ticking every second while a hold exists and is
  // not yet locked -- `aria-live="polite"` per the Accessibility Floor.
  useEffect(() => {
    if (!hold || phase.kind === "locked") return;
    function tick() {
      const remaining = Math.max(0, (hold?.holdExpiresAt ?? 0) - Math.floor(Date.now() / 1000));
      setHoldSecondsLeft(remaining);
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [hold, phase.kind]);

  // Once the reconciler confirms `locked`, the seal is allowed to stamp --
  // never on a submit response alone (the spec's own "Always" rule).
  useEffect(() => {
    if (phase.kind === "reconciling" && booking.data?.escrowState === "locked") {
      setPhase({ kind: "locked", contractId: phase.contractId, txHash: phase.txHash });
    }
  }, [phase, booking.data?.escrowState]);

  async function ensureSessionAndHold() {
    setHoldError(undefined);
    let activeSession = session;
    if (!activeSession) {
      setConnecting(true);
      try {
        activeSession = await signIn();
        setSession(activeSession);
      } catch {
        setConnecting(false);
        setHoldError({ message: "Connection dropped. Your deposit is untouched." });
        return;
      }
      setConnecting(false);
    }
    if (!providerId || slotStartsAt === undefined) return;
    try {
      const result = await holdMutation.mutateAsync({ providerId, slotStartsAt });
      setHold(result);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "SLOT_TAKEN") {
          const details = error.details as { sameDaySlots?: number[] } | undefined;
          setHoldError({ message: "That slot just went.", sameDaySlots: details?.sameDaySlots ?? [] });
          return;
        }
        if (error.code === "SLOT_UNAVAILABLE" || error.code === "PROVIDER_NOT_FOUND") {
          setHoldError({ message: "That slot isn't available anymore." });
          return;
        }
      }
      setHoldError({ message: "Connection dropped. Your deposit is untouched." });
    }
  }

  async function runLockFlow() {
    if (!hold || !session) return;
    setFlowNotice(undefined);
    setFlowFatalError(undefined);
    try {
      let contractId = phase.kind === "deployed" || phase.kind === "funding" || phase.kind === "awaiting-fund-signature" || phase.kind === "submitting-fund" ? phase.contractId : undefined;

      if (!contractId) {
        setPhase({ kind: "deploying" });
        const lockResult = await lockDeposit(hold.bookingId, session);
        setPhase({ kind: "awaiting-deploy-signature" });
        let signedDeployXdr: string;
        try {
          signedDeployXdr = await signXdr(lockResult.unsignedXdr, session.walletAddress);
        } catch {
          setPhase({ kind: "idle" });
          setFlowNotice(`You didn't sign. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
          return;
        }
        setPhase({ kind: "submitting-deploy" });
        await submitSignedTransaction(hold.bookingId, signedDeployXdr, session);
        contractId = lockResult.contractId;
        setPhase({ kind: "deployed", contractId });
      }

      setPhase({ kind: "funding", contractId });
      const fundResult = await fundDepositWithRetry(hold.bookingId, session);
      setPhase({ kind: "awaiting-fund-signature", contractId });
      let signedFundXdr: string;
      try {
        signedFundXdr = await signXdr(fundResult.unsignedXdr, session.walletAddress);
      } catch {
        setPhase({ kind: "deployed", contractId });
        setFlowNotice(`You didn't sign. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
        return;
      }
      setPhase({ kind: "submitting-fund", contractId });
      const submitResult = await submitSignedTransaction(hold.bookingId, signedFundXdr, session);
      setPhase({ kind: "reconciling", contractId, txHash: submitResult.txHash });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "HOLD_EXPIRED") {
          setFlowFatalError("This hold has expired. The slot may already be taken again.");
          setPhase({ kind: "idle" });
          return;
        }
        if (error.code === "ESCROW_REJECTED" || error.code === "ESCROW_UNAVAILABLE") {
          setFlowFatalError("Connection dropped. Your deposit is untouched.");
          setPhase(contractIdFromPhase(phase));
          return;
        }
      }
      setFlowFatalError("Connection dropped. Your deposit is untouched.");
      setPhase(contractIdFromPhase(phase));
    }
  }

  function contractIdFromPhase(current: LockPhase): LockPhase {
    if ("contractId" in current && current.contractId) {
      return { kind: "deployed", contractId: current.contractId };
    }
    return { kind: "idle" };
  }

  if (!providerId || slotStartsAt === undefined) {
    return (
      <div className="page">
        <div className="banner banner--alert">
          <p>No slot was selected. Go back and pick one.</p>
        </div>
      </div>
    );
  }

  if (profileLoading) {
    return (
      <div className="page">
        <p>Loading this booking…</p>
      </div>
    );
  }

  if (profileError || !profile) {
    return (
      <div className="page">
        <div className="banner banner--alert">
          <p>This provider isn't available.</p>
        </div>
      </div>
    );
  }

  const cancelDeadline = hold?.cancelDeadline ?? slotStartsAt - profile.cancellationWindowHours * 3600;
  const depositAmount = hold?.deposit.amount ?? profile.deposit.amount;
  const depositAsset = hold?.deposit.asset ?? profile.deposit.asset;
  const balanceAmount = hold?.balance.amount;
  const isLocked = phase.kind === "locked";
  const waitingOn =
    phase.kind === "awaiting-deploy-signature"
      ? "Create your escrow"
      : phase.kind === "awaiting-fund-signature"
        ? "Lock your deposit"
        : undefined;
  const busy = phase.kind !== "idle" && phase.kind !== "deployed";

  return (
    <div className="page booking-page">
      <div className={`booking-lanes${isLocked ? " booking-lanes--sealed" : ""}`}>
        <section className="booking-lane booking-lane--you">
          <h2 className="booking-lane__heading">YOUR SIDE</h2>
          <p className="booking-lane__appointment">
            {formatSlotDay(slotStartsAt)} · {formatSlotTime(slotStartsAt)}
          </p>
          <p className="booking-lane__meta">
            {SESSION_FORMAT_LABEL[profile.sessionFormat] ?? profile.sessionFormat} · {profile.sessionLengthMinutes} min
          </p>

          <div className="booking-summary">
            <div className="booking-summary__row">
              <span>Price</span>
              <strong className="tabular-nums">{formatMoney(hold?.price.amount ?? profile.price.amount, profile.price.asset)}</strong>
            </div>
            <div className="booking-summary__row">
              <span>Deposit, locked now</span>
              <strong className="tabular-nums">{formatMoney(depositAmount, depositAsset)}</strong>
            </div>
            {balanceAmount && (
              <div className="booking-summary__row">
                <span>Balance, due before the session</span>
                <strong className="tabular-nums">{formatMoney(balanceAmount, depositAsset)}</strong>
              </div>
            )}
            <div className="booking-summary__row">
              <span>Free cancellation until</span>
              <strong>{formatDeadline(cancelDeadline)}</strong>
            </div>
          </div>

          <div className="booking-summary-note">
            <b>YOUR PROTECTION</b>
            <p>
              Your booking policy says cancelling before {formatDeadline(cancelDeadline)} returns all{" "}
              {formatMoney(depositAmount, depositAsset)} through resolution. You (as approver) or the provider may sign the
              supported resolution; Pactly resolves a dispute only after one is opened on chain.
            </p>
          </div>

          <div className="payment-method">
            <div className="payment-method__option payment-method__option--selected">
              <span>Wallet · USDC</span>
            </div>
            <div className="payment-method__option payment-method__option--disabled">
              <span>Local currency — not available yet. Pay with a Stellar wallet holding USDC instead.</span>
            </div>
          </div>

          {!hold && (
            <>
              {holdError && (
                <div className="banner banner--alert" role="alert">
                  <p>{holdError.message}</p>
                  {holdError.sameDaySlots && holdError.sameDaySlots.length > 0 && (
                    <div className="slot-day__chips" style={{ marginTop: "var(--space-3)" }}>
                      {holdError.sameDaySlots.map((startsAt) => (
                        <Link key={startsAt} to={`/book/${providerId}?slot=${startsAt}`} className="slot-chip tabular-nums">
                          {formatSlotTime(startsAt)}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button type="button" className="button-primary" onClick={ensureSessionAndHold} disabled={connecting || holdMutation.isPending}>
                {connecting ? "Connect your wallet…" : holdMutation.isPending ? "Holding your slot…" : session ? "Hold this slot" : "Connect wallet and hold"}
              </button>
            </>
          )}
        </section>

        <EscrowLane
          depositAmount={depositAmount}
          depositAsset={depositAsset}
          holdCountdownLabel={hold && !isLocked ? formatCountdown(holdSecondsLeft) : undefined}
          contractId={"contractId" in phase ? phase.contractId : undefined}
          txHash={"txHash" in phase ? phase.txHash : undefined}
          stateLabel={escrowStateLabel(phase)}
        >
          {hold && !isLocked && (
            <>
              <LockButton waitingOn={waitingOn} disabled={busy && !waitingOn} onClick={runLockFlow} onOpenWalletAgain={runLockFlow} />
              {flowNotice && (
                <p className="escrow-lane__notice" aria-live="polite">
                  {flowNotice}
                </p>
              )}
              {flowFatalError && (
                <p className="escrow-lane__notice escrow-lane__notice--alert" role="alert">
                  {flowFatalError}
                </p>
              )}
            </>
          )}
          {isLocked && (
            <div className={`seal-wrap${prefersReducedMotion ? "" : " seal-wrap--animated"}`}>
              <Seal />
              <p className="seal-wrap__title">You're set.</p>
              <p className="seal-wrap__subtitle">Your deposit is held in Trustless Work escrow on Stellar.</p>
              <Link to="/" className="button-ghost" style={{ marginTop: "var(--space-4)", textDecoration: "none" }}>
                Back to Discover
              </Link>
            </div>
          )}
        </EscrowLane>

        <section className="booking-lane booking-lane--provider">
          <ProviderHeader
            displayName={hold?.provider.displayName ?? profile.displayName}
            title={hold?.provider.title ?? profile.title}
            location={profile.location}
            categoryName={profile.category.name}
            isApproved={profile.isApproved}
            verifiedSessionCount={profile.verifiedSessionCount}
          />
          <div style={{ marginTop: "var(--space-4)" }}>
            <DepositPill amount={depositAmount} asset={depositAsset} cancellationWindowHours={profile.cancellationWindowHours} />
          </div>
          <div className="booking-summary-note booking-summary-note--pro">
            <b>THE PROVIDER'S PROTECTION</b>
            <p>
              A late cancellation or no-show enters resolution under the same booking policy. Neither side can move the deposit
              alone -- the release signer, approver and, for a dispute, Pactly as resolver each sign their own role.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatCountdown(secondsLeft: number | undefined): string {
  if (secondsLeft === undefined) return "—";
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function escrowStateLabel(phase: LockPhase): string {
  switch (phase.kind) {
    case "idle":
      return "Not locked yet";
    case "deploying":
      return "Creating your escrow…";
    case "awaiting-deploy-signature":
      return "Waiting for your signature";
    case "submitting-deploy":
      return "Locking with Pactly…";
    case "deployed":
      return "Escrow created · not yet funded";
    case "funding":
      return "Locking with Pactly…";
    case "awaiting-fund-signature":
      return "Waiting for your signature";
    case "submitting-fund":
      return "Locking with Pactly…";
    case "reconciling":
      return "Locking with Pactly…";
    case "locked":
      return "Locked";
  }
}
