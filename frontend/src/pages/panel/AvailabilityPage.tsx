import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { ApiError } from "../../api/client";
import { useOwnProviderProfile, useUpdateProviderAvailability, useUpdateProviderRules } from "../../api/hooks";
import { formatMoney, parseDecimalToSmallestUnit, smallestUnitToDecimalInput } from "../../lib/money";
import { getSession, signIn, signOut, type Session } from "../../wallet";

const GRID_DAYS = 14;
const GRID_START_HOUR = 8;
const GRID_END_HOUR = 20;
const GRID_STEP_MINUTES = 15;

interface GridDay {
  dayLabel: string;
  cells: number[];
}

/**
 * Candidate start times for the grid: every 15-minute mark from 08:00 to
 * 20:00 local time, for the next 14 days -- the backend's own boundary
 * rule (`startsAt % 900 seconds === 0`, checked against the epoch) holds
 * for these as long as the viewer's UTC offset is itself a multiple of 15
 * minutes, true for the large majority of real time zones (including the
 * demo's Istanbul, UTC+3) and an accepted simplification for this story's
 * grid (no frontend test runner; manual verification only).
 */
function buildGridDays(now: number): GridDay[] {
  const days: GridDay[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let day = 0; day < GRID_DAYS; day += 1) {
    const dayDate = new Date(today);
    dayDate.setDate(dayDate.getDate() + day);
    const cells: number[] = [];
    for (let minutes = GRID_START_HOUR * 60; minutes < GRID_END_HOUR * 60; minutes += GRID_STEP_MINUTES) {
      const cellDate = new Date(dayDate);
      cellDate.setMinutes(minutes);
      const startsAt = Math.floor(cellDate.getTime() / 1000);
      if (startsAt > now) {
        cells.push(startsAt);
      }
    }
    if (cells.length > 0) {
      days.push({
        dayLabel: dayDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        cells,
      });
    }
  }
  return days;
}

/** A voice-guide banner for a save failure that carries no field-level
 * `details` to show instead -- a network failure, or a session that
 * expired mid-edit (401 from `requirePactlyAuth`, which never sends
 * `details`). Without this, such a failure showed nothing at all. */
function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Your session ended. Sign in again.";
  }
  return "Connection dropped. Nothing was saved.";
}

function isBlocked(cell: number, selected: ReadonlySet<number>, sessionSeconds: number): boolean {
  if (selected.has(cell)) {
    return false;
  }
  for (const startsAt of selected) {
    if (Math.abs(cell - startsAt) < sessionSeconds) {
      return true;
    }
  }
  return false;
}

/** A local, preview-only mirror of `services/profile.ts`'s
 * `computeDepositAmount` -- shown as the rules form fills in, but never
 * treated as the saved truth. The server recomputes and returns the
 * authoritative deposit on save; this component only ever renders *that*
 * value once the mutation resolves. */
function previewDeposit(priceSmallestUnit: string | undefined, depositRateBps: number): string | undefined {
  if (!priceSmallestUnit || !Number.isInteger(depositRateBps)) {
    return undefined;
  }
  try {
    return ((BigInt(priceSmallestUnit) * BigInt(depositRateBps)) / 10000n).toString();
  } catch {
    return undefined;
  }
}

/** `/panel/availability` -- the provider's own rules and availability
 * panel (EXPERIENCE.md "Availability & rules"). Desktop-first per Epic 3
 * context; the grid still respects the 44px touch target floor. */
export function AvailabilityPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [signInError, setSignInError] = useState<string | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);

  const profileQuery = useOwnProviderProfile(session);
  const updateRules = useUpdateProviderRules(session);
  const updateAvailability = useUpdateProviderAvailability(session);

  const [priceInput, setPriceInput] = useState("");
  const [depositRateBpsInput, setDepositRateBpsInput] = useState("");
  const [cancellationWindowInput, setCancellationWindowInput] = useState("");
  const [selectedSlots, setSelectedSlots] = useState<Set<number>>(new Set());

  // Seeds local form state only the first time a profile loads, or when it
  // switches to a *different* profile (a new sign-in) -- never on every
  // refetch. Both mutations already re-fetch/re-cache `profileQuery.data`
  // on success (see `api/hooks.ts`), and re-seeding both forms from that
  // response here would silently discard whichever form's edits were not
  // just saved (e.g. saving rules would blow away unsaved slot picks).
  // Each save path updates only its own form's state instead, from the
  // mutation's own response (see `handleSaveRules`/`handleSaveAvailability`).
  const loadedProfileId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (profileQuery.data && profileQuery.data.id !== loadedProfileId.current) {
      loadedProfileId.current = profileQuery.data.id;
      setPriceInput(smallestUnitToDecimalInput(profileQuery.data.price.amount));
      setDepositRateBpsInput(String(profileQuery.data.depositRateBps));
      setCancellationWindowInput(String(profileQuery.data.cancellationWindowHours));
      setSelectedSlots(new Set(profileQuery.data.slots));
    }
  }, [profileQuery.data]);

  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const gridDays = useMemo(() => buildGridDays(now), [now]);
  const sessionSeconds = (profileQuery.data?.sessionLengthMinutes ?? 30) * 60;

  async function handleSignIn(): Promise<void> {
    setSigningIn(true);
    setSignInError(undefined);
    try {
      const nextSession = await signIn();
      setSession(nextSession);
    } catch (error) {
      setSignInError(
        error instanceof ApiError ? error.message : "You didn't sign. The slot is still yours -- nothing changed.",
      );
    } finally {
      setSigningIn(false);
    }
  }

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  const priceSmallestUnit = parseDecimalToSmallestUnit(priceInput);
  const depositRateBps = Number(depositRateBpsInput);
  const cancellationWindowHours = Number(cancellationWindowInput);
  const deposit = previewDeposit(priceSmallestUnit, depositRateBps);

  const rulesErrorDetails =
    updateRules.error instanceof ApiError ? (updateRules.error.details as Record<string, string> | undefined) : undefined;
  const rulesHasFieldError = Boolean(rulesErrorDetails && Object.keys(rulesErrorDetails).length > 0);
  const rulesGenericError = updateRules.error && !rulesHasFieldError ? saveErrorMessage(updateRules.error) : undefined;

  async function handleSaveRules(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!priceSmallestUnit) {
      return;
    }
    try {
      const saved = await updateRules.mutateAsync({
        priceAmount: priceSmallestUnit,
        depositRateBps,
        cancellationWindowHours,
      });
      // Only the rules form's own fields -- an unsaved slot selection in
      // the availability grid below must survive this save untouched.
      setPriceInput(smallestUnitToDecimalInput(saved.price.amount));
      setDepositRateBpsInput(String(saved.depositRateBps));
      setCancellationWindowInput(String(saved.cancellationWindowHours));
    } catch {
      // Surfaced through `updateRules.error`/`rulesErrorDetails`/
      // `rulesGenericError` below -- nothing further to do here.
    }
  }

  function toggleCell(cell: number): void {
    setSelectedSlots((current) => {
      const next = new Set(current);
      if (next.has(cell)) {
        next.delete(cell);
      } else if (!isBlocked(cell, current, sessionSeconds)) {
        next.add(cell);
      }
      return next;
    });
  }

  const availabilityErrorDetails =
    updateAvailability.error instanceof ApiError
      ? (updateAvailability.error.details as { invalid?: number[]; overlapping?: number[]; count?: string } | undefined)
      : undefined;
  const availabilityHasFieldError = Boolean(availabilityErrorDetails && Object.keys(availabilityErrorDetails).length > 0);
  const availabilityGenericError =
    updateAvailability.error && !availabilityHasFieldError ? saveErrorMessage(updateAvailability.error) : undefined;

  async function handleSaveAvailability(): Promise<void> {
    try {
      const saved = await updateAvailability.mutateAsync([...selectedSlots].sort((a, b) => a - b));
      // Only the slot selection -- an unsaved edit in the rules form above
      // must survive this save untouched.
      setSelectedSlots(new Set(saved.slots));
    } catch {
      // Surfaced through `updateAvailability.error`/`availabilityErrorDetails`/
      // `availabilityGenericError` below -- nothing further to do here.
    }
  }

  if (!session) {
    return (
      <div className="page">
        <h1>Availability &amp; rules</h1>
        <p>Sign in with your wallet to manage your price, deposit rate, cancellation window and open slots.</p>
        <button type="button" className="button-primary" onClick={handleSignIn} disabled={signingIn}>
          {signingIn ? "Approve it in your wallet…" : "Sign in with wallet"}
        </button>
        {signInError && (
          <p className="field__error" role="alert">
            {signInError}
          </p>
        )}
      </div>
    );
  }

  if (profileQuery.isLoading) {
    return (
      <div className="page">
        <p>Loading your panel…</p>
      </div>
    );
  }

  if (profileQuery.error) {
    const notAProvider = profileQuery.error instanceof ApiError && profileQuery.error.code === "NOT_A_PROVIDER";
    return (
      <div className="page">
        <div className="banner">
          <p>
            {notAProvider
              ? "This wallet doesn't have a provider profile yet. Becoming a provider is a separate step, coming in a later update."
              : "Connection dropped. Try again."}
          </p>
        </div>
        <button type="button" className="button-ghost" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
    );
  }

  const profile = profileQuery.data;
  if (!profile) {
    return null;
  }

  return (
    <div className="page">
      <div className="top-bar" style={{ padding: 0, border: "none", marginBottom: "var(--space-6)" }}>
        <h1 style={{ margin: 0 }}>Availability &amp; rules</h1>
        <div className="top-bar__nav">
          <Link to={`/providers/${profile.id}`}>View public profile</Link>
          <button type="button" className="button-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </div>

      {!profile.isApproved && (
        <div className="banner" role="status" style={{ marginBottom: "var(--space-6)" }}>
          Your profile is pending approval. You can still set your rules and availability now -- clients will see them
          once you're approved.
        </div>
      )}

      <section className="card" style={{ marginBottom: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Price and deposit</h2>
        {rulesGenericError && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {rulesGenericError}
          </div>
        )}
        <form onSubmit={handleSaveRules}>
          <div className="field">
            <label htmlFor="price">Session price (USDC)</label>
            <input
              id="price"
              inputMode="decimal"
              value={priceInput}
              onChange={(event) => setPriceInput(event.target.value)}
            />
            {rulesErrorDetails?.priceAmount && <span className="field__error">{rulesErrorDetails.priceAmount}</span>}
          </div>
          <div className="field">
            <label htmlFor="depositRateBps">Deposit rate (basis points -- 2000 = 20%)</label>
            <input
              id="depositRateBps"
              inputMode="numeric"
              value={depositRateBpsInput}
              onChange={(event) => setDepositRateBpsInput(event.target.value)}
            />
            {rulesErrorDetails?.depositRateBps && (
              <span className="field__error">{rulesErrorDetails.depositRateBps}</span>
            )}
          </div>
          <div className="field">
            <label htmlFor="cancellationWindowHours">Free-cancellation window (hours)</label>
            <input
              id="cancellationWindowHours"
              inputMode="numeric"
              value={cancellationWindowInput}
              onChange={(event) => setCancellationWindowInput(event.target.value)}
            />
            {rulesErrorDetails?.cancellationWindowHours && (
              <span className="field__error">{rulesErrorDetails.cancellationWindowHours}</span>
            )}
          </div>

          <p className="tabular-nums">
            Deposit preview: {deposit ? formatMoney(deposit, profile.price.asset) : "--"}
            {" "}
            (the saved amount comes back from the server once you save)
          </p>

          <button type="submit" className="button-primary" disabled={updateRules.isPending}>
            {updateRules.isPending ? "Saving…" : "Save rules"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Open slots -- next 14 days, 08:00-20:00</h2>
        {availabilityErrorDetails && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {availabilityErrorDetails.count && <p>{availabilityErrorDetails.count}</p>}
            {availabilityErrorDetails.invalid && <p>Some times can no longer be saved: they're in the past or too far out.</p>}
            {availabilityErrorDetails.overlapping && <p>Some times overlap another selected slot and were not saved.</p>}
          </div>
        )}
        {availabilityGenericError && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {availabilityGenericError}
          </div>
        )}
        <div className="availability-grid">
          {gridDays.map((day) => (
            <div className="availability-grid__day" key={day.dayLabel}>
              <span className="availability-grid__day-label">{day.dayLabel}</span>
              <div className="availability-grid__cells">
                {day.cells.map((cell) => {
                  const selected = selectedSlots.has(cell);
                  const blocked = !selected && isBlocked(cell, selectedSlots, sessionSeconds);
                  return (
                    <button
                      key={cell}
                      type="button"
                      className={`availability-cell tabular-nums${selected ? " availability-cell--selected" : ""}${
                        blocked ? " availability-cell--disabled" : ""
                      }`}
                      aria-pressed={selected}
                      aria-disabled={blocked}
                      onClick={() => toggleCell(cell)}
                    >
                      {new Date(cell * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="button-primary"
          style={{ marginTop: "var(--space-4)" }}
          onClick={handleSaveAvailability}
          disabled={updateAvailability.isPending}
        >
          {updateAvailability.isPending ? "Saving…" : "Save availability"}
        </button>
      </section>
    </div>
  );
}
