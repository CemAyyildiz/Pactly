import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import {
  fundDepositWithRetry,
  getLocalDeposit,
  lockDeposit,
  openLocalDeposit,
  requestAnchorChallenge,
  simulateLocalDeposit,
  submitLocalDepositTrustline,
  submitSignedTransaction,
  useBooking,
  useHoldSlot,
  usePublicProviderProfile,
  verifyAnchorChallenge,
} from "../../api/hooks";
import { ApiError } from "../../api/client";
import type { HoldSlotResponse, LocalDepositView } from "../../api/types";
import { DepositPill } from "../../components/DepositPill";
import { EscrowLane } from "../../components/EscrowLane";
import { LocalCurrencyPanel, localDepositErrorMessage } from "../../components/LocalCurrencyPanel";
import { LockButton } from "../../components/LockButton";
import { ProviderHeader } from "../../components/ProviderHeader";
import { Seal } from "../../components/Seal";
import { TryAmount, useFormatTry } from "../../components/TryAmount";
import { providerPhotoSrc } from "../../lib/providerPhotos";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { getSession, signIn, signOut, signXdr, type Session } from "../../wallet";

/** A human-readable display phase -- distinct from the ref-based "engine"
 * state below (review follow-up: the engine state -- which contractId is
 * in play, whether a deploy has been submitted -- lives in a ref so the
 * async flow functions always read the *current* value, never a value
 * captured by a stale closure from the render that started them). */
type DisplayPhase =
  | "idle"
  | "building-deploy"
  | "awaiting-deploy-signature"
  | "submitting-deploy"
  | "deploy-failed"
  | "deployed"
  | "building-fund"
  | "awaiting-fund-signature"
  | "submitting-fund"
  | "reconciling"
  | "reconciling-slow"
  | "locked";

interface PendingSignature {
  xdr: string;
  kind: "deploy" | "fund";
}

interface FlowEngineState {
  contractId?: string;
  /** `undefined` until a signed deploy matching this contract has actually
   * been relayed and accepted. */
  deploySubmittedAtMs?: number;
}

const SESSION_FORMAT_LABEL: Record<string, string> = {
  video: "Video call",
  in_person: "In person",
};

const RECONCILE_SLOW_AFTER_MS = 3 * 60 * 1000;

function formatDeadline(epochSeconds: number): string {
  return `${formatSlotDay(epochSeconds)} · ${formatSlotTime(epochSeconds)}`;
}

function parseIntegerSlot(raw: string | null): number | undefined {
  if (!raw || !/^-?\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
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
  const slotStartsAt = parseIntegerSlot(searchParams.get("slot"));

  const { data: profile, isLoading: profileLoading, error: profileError } = usePublicProviderProfile(providerId);

  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [connecting, setConnecting] = useState(false);
  const [holdError, setHoldError] = useState<{ message: string; sameDaySlots?: number[] } | undefined>();
  const [hold, setHold] = useState<HoldSlotResponse | undefined>();
  const [holdSecondsLeft, setHoldSecondsLeft] = useState<number | undefined>();
  const [holdEndedWhileIdle, setHoldEndedWhileIdle] = useState(false);

  const holdMutation = useHoldSlot();

  const [phase, setPhase] = useState<DisplayPhase>("idle");
  const [pendingSignature, setPendingSignature] = useState<PendingSignature | undefined>();
  const [flowNotice, setFlowNotice] = useState<string | undefined>();
  const [flowFatalError, setFlowFatalError] = useState<string | undefined>();
  const [needsSignIn, setNeedsSignIn] = useState(false);
  // 2026-09 pivot: the TRY bank transfer is the only way to pay the
  // deposit -- there is no payment-method choice any more, so the local
  // transfer state below is always the live path once a hold exists.
  const [localDeposit, setLocalDeposit] = useState<LocalDepositView | undefined>();
  const [localBusy, setLocalBusy] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | undefined>();

  // Review follow-up: the flow's own "engine" state (which contractId is in
  // play, whether a deploy has actually been submitted) lives in a ref, not
  // in React state read through a closure -- `runLockFlow` and
  // `retryPendingSignature` are long-running async functions with several
  // `await` points, and only a ref is guaranteed to reflect the *current*
  // value at each one rather than whatever was true when that particular
  // invocation started.
  const engineRef = useRef<FlowEngineState>({});
  // Guards re-entry: a second tap of "Lock with Pactly" (or "Open wallet
  // again") while a flow is already in flight must never start a second,
  // concurrent one.
  const inFlightRef = useRef(false);
  const reconcileStartedAtRef = useRef<number | undefined>(undefined);

  const resumeAttemptedRef = useRef(false);
  const formatTryAmount = useFormatTry();

  const isLocked = phase === "locked";
  const booking = useBooking(hold?.bookingId, session, {
    enabled: phase === "reconciling" || phase === "reconciling-slow" || isLocked,
  });

  const prefersReducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // The hold countdown, ticking every second while a hold exists and is
  // not yet locked -- `aria-live="polite"` per the Accessibility Floor.
  useEffect(() => {
    if (!hold || isLocked) return;
    function tick() {
      const remaining = Math.max(0, (hold?.holdExpiresAt ?? 0) - Math.floor(Date.now() / 1000));
      setHoldSecondsLeft(remaining);
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [hold, isLocked]);

  // Review follow-up: if the hold's own countdown reaches zero while the
  // client has not even started the lock flow yet, the hold is cleared
  // client-side and the "hold this slot again" button comes back --
  // resuming a flow already in progress is a different, allowed case
  // (submit is permitted after expiry; this only covers the *idle* case).
  useEffect(() => {
    if (phase === "idle" && hold && holdSecondsLeft === 0) {
      setHold(undefined);
      setHoldEndedWhileIdle(true);
      engineRef.current = {};
    }
  }, [phase, hold, holdSecondsLeft]);

  // Once the reconciler confirms `locked`, the seal is allowed to stamp --
  // never on a submit response alone (the spec's own "Always" rule).
  useEffect(() => {
    if ((phase === "reconciling" || phase === "reconciling-slow") && booking.data?.escrowState === "locked") {
      setPhase("locked");
    }
  }, [phase, booking.data?.escrowState]);

  // Story 2.4: poll the local-currency transfer while it is waiting, so
  // a completed (or simulated) bank transfer surfaces as "Money received"
  // without a reload. 4s is coarse enough not to hammer the anchor.
  useEffect(() => {
    if (!hold || !session || !localDeposit) return;
    if (localDeposit.status !== "waiting" && localDeposit.status !== "paying" && localDeposit.status !== "needs_trustline") return;
    const interval = setInterval(() => {
      void getLocalDeposit(hold.bookingId, session)
        .then((next) => {
          setLocalDeposit(next);
          if (next.holdExpiresAt) {
            setHold((current) => (current ? { ...current, holdExpiresAt: next.holdExpiresAt ?? current.holdExpiresAt } : current));
          }
        })
        .catch(() => {
          /* last known status stays on screen */
        });
    }, 4000);
    return () => clearInterval(interval);
  }, [hold, session, localDeposit]);

  // Review follow-up: after 3 minutes without `locked`, stop implying an
  // endless spinner is normal -- the deposit is still safe (the reconciler
  // keeps trying independently of this tab), just say so plainly.
  useEffect(() => {
    if (phase === "reconciling") {
      reconcileStartedAtRef.current = Date.now();
      const timer = setTimeout(() => setPhase((current) => (current === "reconciling" ? "reconciling-slow" : current)), RECONCILE_SLOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  // A signed-in client who already holds this slot (refresh, My bookings
  // continue, or a second visit) gets that hold back without tapping Hold
  // again. The hold endpoint is idempotent for the same wallet + slot.
  useEffect(() => {
    if (resumeAttemptedRef.current) return;
    if (!session || !providerId || slotStartsAt === undefined || hold) return;
    resumeAttemptedRef.current = true;
    void holdMutation
      .mutateAsync({ providerId, slotStartsAt, token: session.token, tzOffsetMinutes: new Date().getTimezoneOffset() })
      .then((result) => {
        setHold(result);
        setHoldEndedWhileIdle(false);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          resumeAttemptedRef.current = false;
          handleUnauthorized();
          return;
        }
        if (error instanceof ApiError && error.code === "TOO_MANY_HOLDS") {
          setHoldError({
            message: "You already have other slots on hold. Continue one from My bookings.",
          });
          return;
        }
        resumeAttemptedRef.current = false;
      });
  }, [session, providerId, slotStartsAt, hold, holdMutation]);

  // Restore an in-flight local-currency transfer after hold resume.
  useEffect(() => {
    if (!hold || !session) return;
    let cancelled = false;
    void getLocalDeposit(hold.bookingId, session)
      .then((view) => {
        if (!cancelled) setLocalDeposit(view);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && (error.code === "BOOKING_STATE" || error.status === 409)) return;
      });
    return () => {
      cancelled = true;
    };
  }, [hold, session]);

  function handleUnauthorized(): void {
    signOut();
    setSession(undefined);
    setNeedsSignIn(true);
  }

  async function ensureSessionAndHold() {
    setHoldError(undefined);
    setHoldEndedWhileIdle(false);
    setNeedsSignIn(false);
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
      // Review follow-up: the fresh token is passed explicitly, rather than
      // relying on a `useHoldSlot(session)`-style hook whose closure would
      // still hold the *previous* (absent) session on this very first call
      // -- `setSession` above only takes effect on the next render.
      const result = await holdMutation.mutateAsync({ providerId, slotStartsAt, token: activeSession.token, tzOffsetMinutes: new Date().getTimezoneOffset() });
      setHold(result);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          handleUnauthorized();
          return;
        }
        if (error.code === "SLOT_TAKEN") {
          const details = error.details as { sameDaySlots?: number[] } | undefined;
          setHoldError({ message: "That slot just went.", sameDaySlots: details?.sameDaySlots ?? [] });
          return;
        }
        if (error.code === "SLOT_UNAVAILABLE" || error.code === "PROVIDER_NOT_FOUND") {
          setHoldError({ message: "That slot isn't available anymore." });
          return;
        }
        if (error.code === "TOO_MANY_HOLDS") {
          setHoldError({
            message: "You already have slots on hold. Open My bookings and continue one of those — don't hold a new slot.",
          });
          return;
        }
      }
      setHoldError({ message: "Connection dropped. Your deposit is untouched." });
    }
  }

  function describeError(error: unknown): { fatal: boolean; message: string } {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        return { fatal: true, message: "unauthorized" };
      }
      if (error.code === "HOLD_EXPIRED") {
        return { fatal: true, message: "This hold has expired. The slot may already be taken again." };
      }
    }
    return { fatal: true, message: "Connection dropped. Your deposit is untouched." };
  }

  function handleFlowError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    const described = describeError(error);
    setFlowFatalError(described.message);
    if (error instanceof ApiError && error.code === "HOLD_EXPIRED") {
      setHold(undefined);
      engineRef.current = {};
      setPhase("idle");
      return;
    }
    // Fall back to whatever step is still resumable: once a deploy is
    // confirmed submitted, stay there (fund can be retried); otherwise go
    // back to idle so "Lock with Pactly" starts clean.
    setPhase(engineRef.current.deploySubmittedAtMs ? "deployed" : "idle");
  }

  /** The main flow: lock (build or reuse a deploy) -> sign -> submit ->
   * fund -> sign -> submit -> reconcile. `rebuild` is only ever passed
   * explicitly, from the "Try again" action after a failed deploy submit. */
  async function runLockFlow(options: { rebuild?: boolean } = {}): Promise<void> {
    if (!hold || !session) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setFlowNotice(undefined);
    setFlowFatalError(undefined);
    try {
      if (!engineRef.current.deploySubmittedAtMs) {
        setPhase("building-deploy");
        const lockResult = await lockDeposit(hold.bookingId, session, options.rebuild ?? false);
        if (lockResult.deployed) {
          engineRef.current.contractId = lockResult.contractId;
          // A deploy was already confirmed submitted in an earlier session
          // (e.g. a reload) -- there is no local submission timestamp to
          // reuse, so treat "now" as the start of the fund-retry window.
          engineRef.current.deploySubmittedAtMs = Date.now();
        } else {
          engineRef.current.contractId = lockResult.contractId;
          setPendingSignature({ xdr: lockResult.unsignedXdr, kind: "deploy" });
          setPhase("awaiting-deploy-signature");
          let signedXdr: string;
          try {
            signedXdr = await signXdr(lockResult.unsignedXdr, session.walletAddress);
          } catch {
            setPendingSignature(undefined);
            setPhase("idle");
            setFlowNotice(`You didn't sign. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
            return;
          }
          setPhase("submitting-deploy");
          try {
            await submitSignedTransaction(hold.bookingId, signedXdr, session);
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
              handleUnauthorized();
              return;
            }
            setPendingSignature(undefined);
            setPhase("deploy-failed");
            setFlowFatalError("Connection dropped. Your deposit is untouched.");
            return;
          }
          engineRef.current.deploySubmittedAtMs = Date.now();
          setPendingSignature(undefined);
        }
      }

      await runFundStep();
    } catch (error) {
      handleFlowError(error);
    } finally {
      inFlightRef.current = false;
    }
  }

  async function runFundStep(): Promise<void> {
    if (!hold || !session || !engineRef.current.deploySubmittedAtMs) return;
    setPhase("building-fund");
    const fundResult = await fundDepositWithRetry(hold.bookingId, session, engineRef.current.deploySubmittedAtMs);
    setPendingSignature({ xdr: fundResult.unsignedXdr, kind: "fund" });
    setPhase("awaiting-fund-signature");
    let signedFundXdr: string;
    try {
      signedFundXdr = await signXdr(fundResult.unsignedXdr, session.walletAddress);
    } catch {
      setPendingSignature(undefined);
      setPhase("deployed");
      setFlowNotice(`You didn't sign. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
      return;
    }
    setPhase("submitting-fund");
    await submitSignedTransaction(hold.bookingId, signedFundXdr, session);
    setPendingSignature(undefined);
    setPhase("reconciling");
  }

  /** "Open wallet again": re-issues *only* the currently pending signature
   * request -- never restarts the whole lock/fund sequence (review
   * follow-up: the previous version's "Open wallet again" called the same
   * top-level flow function again, which could re-enter earlier steps). */
  async function retryPendingSignature(): Promise<void> {
    if (!pendingSignature || !session || !hold) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      let signed: string;
      try {
        signed = await signXdr(pendingSignature.xdr, session.walletAddress);
      } catch {
        setFlowNotice(`You didn't sign. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
        return;
      }
      if (pendingSignature.kind === "deploy") {
        setPhase("submitting-deploy");
        try {
          await submitSignedTransaction(hold.bookingId, signed, session);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            handleUnauthorized();
            return;
          }
          setPendingSignature(undefined);
          setPhase("deploy-failed");
          setFlowFatalError("Connection dropped. Your deposit is untouched.");
          return;
        }
        engineRef.current.deploySubmittedAtMs = Date.now();
        setPendingSignature(undefined);
        // Kept guarded (the `finally` below releases it) through the fund
        // step too -- releasing early here would open a window for a
        // concurrent call to re-enter while it is still running.
        await runFundStep();
        return;
      }
      setPhase("submitting-fund");
      await submitSignedTransaction(hold.bookingId, signed, session);
      setPendingSignature(undefined);
      setPhase("reconciling");
    } catch (error) {
      handleFlowError(error);
    } finally {
      inFlightRef.current = false;
    }
  }

  function tryAgainAfterFailedDeploy(): void {
    engineRef.current = {};
    void runLockFlow({ rebuild: true });
  }

  async function ensureAnchorAuth(activeSession: Session, bookingId: string): Promise<boolean> {
    const challenge = await requestAnchorChallenge(bookingId, activeSession);
    if (challenge.authenticated || !challenge.unsignedXdr) {
      return true;
    }
    let signed: string;
    try {
      signed = await signXdr(challenge.unsignedXdr, activeSession.walletAddress);
    } catch {
      setLocalNotice(`You didn't sign. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
      return false;
    }
    await verifyAnchorChallenge(bookingId, signed, activeSession);
    return true;
  }

  async function applyLocalDepositResponse(
    activeSession: Session,
    bookingId: string,
    result: Awaited<ReturnType<typeof openLocalDeposit>>,
  ): Promise<void> {
    if ("needsTrustline" in result && result.needsTrustline) {
      setLocalNotice("Getting your wallet ready");
      let signed: string;
      try {
        signed = await signXdr(result.unsignedXdr, activeSession.walletAddress);
      } catch {
        setLocalNotice(`You didn't sign. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
        return;
      }
      const opened = await submitLocalDepositTrustline(bookingId, signed, activeSession);
      if ("needsTrustline" in opened && opened.needsTrustline) {
        setLocalNotice("Getting your wallet ready did not finish. Try again.");
        return;
      }
      setLocalDeposit(opened);
      if (opened.holdExpiresAt) {
        setHold((current) => (current ? { ...current, holdExpiresAt: opened.holdExpiresAt ?? current.holdExpiresAt } : current));
      }
      return;
    }
    setLocalDeposit(result);
    if (result.holdExpiresAt) {
      setHold((current) => (current ? { ...current, holdExpiresAt: result.holdExpiresAt ?? current.holdExpiresAt } : current));
    }
  }

  async function startLocalCurrency(): Promise<void> {
    if (!hold || !session) return;
    setLocalBusy(true);
    setLocalNotice(undefined);
    setHoldError(undefined);
    try {
      const authed = await ensureAnchorAuth(session, hold.bookingId);
      if (!authed) return;
      const result = await openLocalDeposit(hold.bookingId, session);
      await applyLocalDepositResponse(session, hold.bookingId, result);
    } catch (error) {
      const message = localDepositErrorMessage(error);
      if (message === "unauthorized") {
        handleUnauthorized();
        return;
      }
      if (error instanceof ApiError && error.code === "HOLD_EXPIRED") {
        setHold(undefined);
        setHoldError({ message });
        setPhase("idle");
        return;
      }
      setLocalNotice(message);
    } finally {
      setLocalBusy(false);
    }
  }

  async function handleSimulate(): Promise<void> {
    if (!hold || !session) return;
    setLocalBusy(true);
    setLocalNotice(undefined);
    try {
      const result = await simulateLocalDeposit(hold.bookingId, session);
      setLocalDeposit(result);
      if (result.holdExpiresAt) {
        setHold((current) => (current ? { ...current, holdExpiresAt: result.holdExpiresAt ?? current.holdExpiresAt } : current));
      }
    } catch (error) {
      const message = localDepositErrorMessage(error);
      if (message === "unauthorized") {
        handleUnauthorized();
        return;
      }
      setLocalNotice(message);
    } finally {
      setLocalBusy(false);
    }
  }

  const localReceived = localDeposit?.status === "received";
  // "Lock with Pactly" only ever appears once the bank transfer is in.
  const showLock = Boolean(hold) && localReceived;

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
  const balanceAmount = hold?.balance.amount;
  const waitingOn =
    phase === "awaiting-deploy-signature" ? "Create your escrow" : phase === "awaiting-fund-signature" ? "Lock your deposit" : undefined;
  const busy = phase !== "idle" && phase !== "deployed" && phase !== "deploy-failed";

  return (
    <div className="page booking-page">
      <div className={`booking-lanes${isLocked ? " booking-lanes--sealed" : ""}`}>
        <section className="booking-lane booking-lane--client">
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
              <strong>
                <TryAmount amount={hold?.price.amount ?? profile.price.amount} />
              </strong>
            </div>
            <div className="booking-summary__row">
              <span>Deposit, locked now</span>
              <strong>
                <TryAmount amount={depositAmount} />
              </strong>
            </div>
            {balanceAmount && (
              <div className="booking-summary__row">
                <span>Balance, due before the session</span>
                <strong>
                  <TryAmount amount={balanceAmount} />
                </strong>
              </div>
            )}
            <div className="booking-summary__row">
              <span>Free cancellation until</span>
              <strong>{hold?.freeCancellationEnded ? "already passed" : formatDeadline(cancelDeadline)}</strong>
            </div>
          </div>

          <div className="booking-summary-note">
            <b>YOUR PROTECTION</b>
            <p>
              {hold?.freeCancellationEnded
                ? "The free-cancellation window has already passed for this appointment. A cancellation from here goes through resolution under the booking policy."
                : `Your booking policy says cancelling before ${formatDeadline(cancelDeadline)} returns all ${formatTryAmount(depositAmount)} through resolution.`}{" "}
              You (as approver) or the provider may sign the supported resolution; Pactly resolves a dispute only after one is opened on
              chain.
            </p>
          </div>

          {needsSignIn && (
            <div className="banner banner--alert" role="alert">
              <p>Your session ended. Sign in again to continue.</p>
            </div>
          )}

          {holdError && (
            <div className="banner banner--alert" role="alert">
              <p>{holdError.message}</p>
              {holdError.message.includes("My bookings") && (
                <p style={{ marginTop: "var(--space-3)" }}>
                  <Link to="/me/bookings">Open My bookings</Link>
                </p>
              )}
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

          {!hold && (
            <div className="booking-pay">
              <p className="booking-step">Step 1 · Hold the slot</p>
              {holdEndedWhileIdle && (
                <div className="banner" role="status">
                  <p>Your hold ended. Hold this slot again.</p>
                </div>
              )}
              <button type="button" className="button-primary" onClick={ensureSessionAndHold} disabled={connecting || holdMutation.isPending}>
                {connecting ? "Connect your wallet…" : holdMutation.isPending ? "Holding your slot…" : session ? "Hold this slot" : "Connect wallet and hold"}
              </button>
            </div>
          )}

          {hold && !isLocked && (
            <div className="booking-pay">
              <p className="booking-step">Step 1 · Slot held{holdSecondsLeft !== undefined ? ` · ${formatCountdown(holdSecondsLeft)} left` : ""}</p>
              <p className="booking-step">Step 2 · Pay the deposit by bank transfer</p>
              <p className="local-deposit__how">
                Send the deposit in TRY to the bank details below. Trustless Work holds it in escrow — not Pactly, not the provider.
              </p>

              <div className="booking-pay__action">
                {!localDeposit && (
                  <button type="button" className="button-primary" onClick={() => void startLocalCurrency()} disabled={localBusy}>
                    {localBusy ? "Opening the transfer…" : "Get bank details"}
                  </button>
                )}
                {localDeposit && (
                  <LocalCurrencyPanel
                    deposit={localDeposit}
                    amount={depositAmount}
                    busy={localBusy}
                    onSimulate={() => void handleSimulate()}
                    onRetry={() => void startLocalCurrency()}
                  />
                )}
                {localReceived && (
                  <>
                    <p className="booking-step">Step 3 · Lock the deposit</p>
                    {phase === "deploy-failed" ? (
                      <button type="button" className="button-primary" onClick={tryAgainAfterFailedDeploy}>
                        Try again
                      </button>
                    ) : (
                      <LockButton
                        waitingOn={waitingOn}
                        disabled={busy && !waitingOn}
                        onClick={() => void runLockFlow()}
                        onOpenWalletAgain={() => void retryPendingSignature()}
                      />
                    )}
                  </>
                )}
                {localNotice && (
                  <p className="escrow-lane__notice" aria-live="polite">
                    {localNotice}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        <EscrowLane
          depositAmount={depositAmount}
          holdCountdownLabel={hold && !isLocked ? formatCountdown(holdSecondsLeft) : undefined}
          contractId={engineRef.current.contractId}
          showProof={isLocked}
          stateLabel={!hold ? "Hold the slot to pay" : escrowStateLabel(phase)}
        >
          {showLock && !isLocked && (
            <>
              {phase === "deploy-failed" ? (
                <button type="button" className="button-escrow" onClick={tryAgainAfterFailedDeploy}>
                  Try again
                </button>
              ) : (
                <LockButton
                  waitingOn={waitingOn}
                  disabled={busy && !waitingOn}
                  onClick={() => void runLockFlow()}
                  onOpenWalletAgain={() => void retryPendingSignature()}
                />
              )}
              {phase === "reconciling-slow" && (
                <p className="escrow-lane__notice" aria-live="polite">
                  This is taking longer than usual. Your deposit is safe; check My bookings shortly.
                </p>
              )}
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
              <p className="seal-wrap__subtitle">Your deposit is held in escrow by Trustless Work.</p>
              <Link to="/discover" className="button-ghost" style={{ marginTop: "var(--space-4)", textDecoration: "none" }}>
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
            photoSrc={providerPhotoSrc(profile.id)}
            compact
          />
          <div style={{ marginTop: "var(--space-4)" }}>
            <DepositPill
              amount={depositAmount}
              cancellationWindowHours={profile.cancellationWindowHours}
              freeCancellationEnded={hold?.freeCancellationEnded}
            />
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

function escrowStateLabel(phase: DisplayPhase): string {
  switch (phase) {
    case "idle":
      return "Not locked yet";
    case "building-deploy":
      return "Creating your escrow…";
    case "awaiting-deploy-signature":
      return "Waiting for your signature";
    case "submitting-deploy":
      return "Locking with Pactly…";
    case "deploy-failed":
      return "Your escrow could not be created";
    case "deployed":
      return "Escrow created · not yet funded";
    case "building-fund":
      return "Locking with Pactly…";
    case "awaiting-fund-signature":
      return "Waiting for your signature";
    case "submitting-fund":
      return "Locking with Pactly…";
    case "reconciling":
    case "reconciling-slow":
      return "Locking with Pactly…";
    case "locked":
      return "Locked";
  }
}
