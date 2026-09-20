import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { HourglassIcon, SealCheckIcon, StorefrontIcon, WarningCircleIcon } from "@phosphor-icons/react";

import { ApiError } from "../../api/client";
import { useCategories, useOwnProviderApplication, useOwnProviderProfile, useSubmitProviderApplication } from "../../api/hooks";
import type { ProviderApplication } from "../../api/types";
import { PageMasthead } from "../../components/PageMasthead";
import { SignInPanel } from "../../components/SignInPanel";
import { formatMoney, parseDecimalToSmallestUnit, smallestUnitToDecimalInput } from "../../lib/money";
import { formatSessionFormat } from "../../lib/sessionFormat";
import { getSession, signOut, type Session } from "../../wallet";

const SESSION_FORMATS = ["in_person", "video"] as const;

interface FormValues {
  name: string;
  title: string;
  categoryId: string;
  location: string;
  serviceDescription: string;
  sessionFormat: string;
  sessionLengthMinutes: string;
  price: string;
  depositRatePercent: string;
  cancellationWindowHours: string;
}

const EMPTY_FORM: FormValues = {
  name: "",
  title: "",
  categoryId: "",
  location: "",
  serviceDescription: "",
  sessionFormat: "in_person",
  sessionLengthMinutes: "45",
  price: "",
  depositRatePercent: "25",
  cancellationWindowHours: "24",
};

/** A rejected application pre-fills the form so the applicant only fixes
 * what the reason asked for. Location is not stored on the application
 * (the profile carries it), so it starts empty again. */
function formFromApplication(application: ProviderApplication): FormValues {
  return {
    name: application.name,
    title: application.title,
    categoryId: application.category.id,
    location: "",
    serviceDescription: application.serviceDescription,
    sessionFormat: application.sessionFormat,
    sessionLengthMinutes: String(application.sessionLengthMinutes),
    price: smallestUnitToDecimalInput(application.price.amount),
    depositRatePercent: String(application.depositRateBps / 100),
    cancellationWindowHours: String(application.cancellationWindowHours),
  };
}

/** Preview only -- the backend recomputes and returns the authoritative
 * deposit (same rule `AvailabilityPage` follows). */
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

/**
 * `/providers/apply` -- "List your shop" (Story 4.1). Signed out, it
 * explains the three steps and asks for a passkey sign-in; signed in, it
 * shows the account's own application state or the form. Applying creates
 * the unapproved profile, so the panel opens right away while an admin
 * decides (Story 4.2).
 */
export function ApplyPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());

  const categoriesQuery = useCategories();
  const applicationQuery = useOwnProviderApplication(session);
  const profileQuery = useOwnProviderProfile(session);
  const submit = useSubmitProviderApplication(session);

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  const masthead = (
    <PageMasthead
      eyebrow="List your shop"
      icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
      title="Become a provider"
      lede="Tell us about the chair, room or call you sell. Every booking you take is backed by a deposit that waits in escrow -- not in your client's promise."
      actions={
        session ? (
          <button type="button" className="button-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        ) : undefined
      }
    />
  );

  if (!session) {
    return (
      <div className="page">
        {masthead}
        <ol className="apply-steps">
          <li>
            <div>
              <b>Sign in with your passkey</b>
              <p>Your face, fingerprint or device PIN is your provider account -- released deposits land there. No email, no password, no wallet app.</p>
            </div>
          </li>
          <li>
            <div>
              <b>Describe your service and set your rules</b>
              <p>Price, deposit rate and free-cancellation window. Clients see all three before they book.</p>
            </div>
          </li>
          <li>
            <div>
              <b>Pactly reviews, then you go live</b>
              <p>While we review you can already open your panel and set your open slots. Once approved, you're listed.</p>
            </div>
          </li>
        </ol>
        <SignInPanel
          onSignedIn={setSession}
          intro="Sign in with your passkey — no email, no password, no wallet app. First time here? The same tap creates your account."
        />
      </div>
    );
  }

  if (applicationQuery.isLoading || profileQuery.isLoading) {
    return (
      <div className="page">
        {masthead}
        <p>Checking your account…</p>
      </div>
    );
  }

  if (applicationQuery.error) {
    return (
      <div className="page">
        {masthead}
        <div className="banner banner--alert" role="alert">
          <p>Connection dropped. Try again.</p>
        </div>
      </div>
    );
  }

  const application = applicationQuery.data ?? null;
  const profile = profileQuery.data;

  if (application?.state === "pending") {
    return (
      <div className="page">
        {masthead}
        <div className="card apply-status apply-status--pending" role="status">
          <HourglassIcon size={28} weight="fill" aria-hidden="true" />
          <div>
            <h2>Application received</h2>
            <p>
              <b>{application.name}</b> · {application.title} · {application.category.name}. Pactly is reviewing it; you'll see
              the decision here.
            </p>
            <p>
              Meanwhile your panel is open: set your open slots now so you're bookable the moment you're approved.
            </p>
            <div className="apply-status__actions">
              <Link to="/panel/availability" className="button-primary" style={{ textDecoration: "none" }}>
                Open my panel
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (application?.state === "approved" || profile?.isApproved) {
    return (
      <div className="page">
        {masthead}
        <div className="card apply-status apply-status--approved" role="status">
          <SealCheckIcon size={28} weight="fill" aria-hidden="true" />
          <div>
            <h2>You're listed</h2>
            <p>Your shop is on the marketplace. Keep your slots up to date and your bookings will come through the panel.</p>
            <div className="apply-status__actions">
              <Link to="/panel/availability" className="button-primary" style={{ textDecoration: "none" }}>
                Availability &amp; rules
              </Link>
              <Link to="/panel/bookings" className="button-ghost" style={{ textDecoration: "none" }}>
                Bookings
              </Link>
              {profile ? (
                <Link to={`/providers/${profile.id}`} className="button-ghost" style={{ textDecoration: "none" }}>
                  View public profile
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {masthead}
      {application?.state === "rejected" && (
        <div className="card apply-status apply-status--rejected" role="alert" style={{ marginBottom: "var(--space-6)" }}>
          <WarningCircleIcon size={28} weight="fill" aria-hidden="true" />
          <div>
            <h2>Not approved yet</h2>
            <p>
              Pactly's note: <b>{application.rejectionReason ?? "no reason recorded"}</b>
            </p>
            <p style={{ marginBottom: 0 }}>Fix what's asked for below and send it again.</p>
          </div>
        </div>
      )}
      <ApplicationForm
        key={application?.id ?? "new"}
        initial={application ? formFromApplication(application) : EMPTY_FORM}
        categories={categoriesQuery.data?.categories ?? []}
        pending={submit.isPending}
        error={submit.error}
        onSubmit={(input) => submit.mutate(input)}
      />
    </div>
  );
}

interface ApplicationFormProps {
  initial: FormValues;
  categories: Array<{ id: string; name: string }>;
  pending: boolean;
  error: unknown;
  onSubmit: (input: Parameters<ReturnType<typeof useSubmitProviderApplication>["mutate"]>[0]) => void;
}

function ApplicationForm({ initial, categories, pending, error, onSubmit }: ApplicationFormProps) {
  const [values, setValues] = useState<FormValues>(initial);

  const details = error instanceof ApiError ? ((error.details ?? {}) as Record<string, string>) : {};
  const genericError =
    error instanceof ApiError && Object.keys(details).length === 0
      ? error.message
      : error && !(error instanceof ApiError)
        ? "Connection dropped. Nothing was sent."
        : undefined;

  const priceSmallestUnit = parseDecimalToSmallestUnit(values.price);
  const depositRateBps = Math.round(Number(values.depositRatePercent) * 100);
  const deposit = previewDeposit(priceSmallestUnit, depositRateBps);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    onSubmit({
      name: values.name,
      title: values.title,
      categoryId: values.categoryId,
      location: values.location,
      serviceDescription: values.serviceDescription,
      sessionFormat: values.sessionFormat,
      sessionLengthMinutes: Number(values.sessionLengthMinutes),
      priceAmount: priceSmallestUnit ?? "",
      depositRateBps,
      cancellationWindowHours: Number(values.cancellationWindowHours),
    });
  }

  return (
    <form className="card apply-form" onSubmit={handleSubmit} noValidate>
      <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Your shop</h2>
      {genericError && (
        <div className="banner banner--alert" role="alert">
          {genericError}
        </div>
      )}

      <div className="apply-form__row">
        <div className="field">
          <label htmlFor="apply-name">Shop or your name</label>
          <input id="apply-name" value={values.name} onChange={(e) => set("name", e.target.value)} autoComplete="organization" required />
          {details.name && <p className="field__error">{details.name}</p>}
        </div>
        <div className="field">
          <label htmlFor="apply-title">What you do</label>
          <input id="apply-title" value={values.title} onChange={(e) => set("title", e.target.value)} placeholder="Barber · cut and beard" required />
          {details.title && <p className="field__error">{details.title}</p>}
        </div>
      </div>

      <div className="apply-form__row">
        <div className="field">
          <label htmlFor="apply-category">Category</label>
          <select id="apply-category" value={values.categoryId} onChange={(e) => set("categoryId", e.target.value)} required>
            <option value="">Pick one</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          {details.categoryId && <p className="field__error">{details.categoryId}</p>}
        </div>
        <div className="field">
          <label htmlFor="apply-location">Where</label>
          <input id="apply-location" value={values.location} onChange={(e) => set("location", e.target.value)} placeholder="Moda, Kadıköy, Istanbul" autoComplete="street-address" required />
          {details.location && <p className="field__error">{details.location}</p>}
        </div>
      </div>

      <div className="field">
        <label htmlFor="apply-description">The service, in a few sentences</label>
        <textarea id="apply-description" rows={3} value={values.serviceDescription} onChange={(e) => set("serviceDescription", e.target.value)} required />
        <p className="field__hint">Clients search this text. Say what happens in the chair, the room or the call.</p>
        {details.serviceDescription && <p className="field__error">{details.serviceDescription}</p>}
      </div>

      <div className="apply-form__row">
        <div className="field">
          <label htmlFor="apply-format">Session format</label>
          <select id="apply-format" value={values.sessionFormat} onChange={(e) => set("sessionFormat", e.target.value)}>
            {SESSION_FORMATS.map((format) => (
              <option key={format} value={format}>
                {formatSessionFormat(format)}
              </option>
            ))}
          </select>
          {details.sessionFormat && <p className="field__error">{details.sessionFormat}</p>}
        </div>
        <div className="field">
          <label htmlFor="apply-length">Session length (minutes)</label>
          <input id="apply-length" type="number" inputMode="numeric" min={15} max={240} step={5} value={values.sessionLengthMinutes} onChange={(e) => set("sessionLengthMinutes", e.target.value)} required />
          {details.sessionLengthMinutes && <p className="field__error">{details.sessionLengthMinutes}</p>}
        </div>
      </div>

      <h2 style={{ fontSize: "var(--text-18)", marginTop: "var(--space-4)" }}>Your rules</h2>
      <div className="apply-form__row">
        <div className="field">
          <label htmlFor="apply-price">Price (USDC)</label>
          <input id="apply-price" inputMode="decimal" value={values.price} onChange={(e) => set("price", e.target.value)} placeholder="60.00" required />
          {details.priceAmount && <p className="field__error">{details.priceAmount}</p>}
        </div>
        <div className="field">
          <label htmlFor="apply-deposit">Deposit rate (%)</label>
          <input id="apply-deposit" type="number" inputMode="decimal" min={0.01} max={100} step={0.5} value={values.depositRatePercent} onChange={(e) => set("depositRatePercent", e.target.value)} required />
          <p className="field__hint">
            {deposit ? `Clients lock ${formatMoney(deposit, "USDC")} in escrow when they book.` : "Typical rate 20-30%. Held in Trustless Work escrow on Stellar."}
          </p>
          {details.depositRateBps && <p className="field__error">{details.depositRateBps}</p>}
        </div>
      </div>
      <div className="apply-form__row">
        <div className="field">
          <label htmlFor="apply-window">Free cancellation until (hours before)</label>
          <input id="apply-window" type="number" inputMode="numeric" min={0} max={720} value={values.cancellationWindowHours} onChange={(e) => set("cancellationWindowHours", e.target.value)} required />
          <p className="field__hint">Cancelling later than this enters resolution under your booking policy.</p>
          {details.cancellationWindowHours && <p className="field__error">{details.cancellationWindowHours}</p>}
        </div>
      </div>

      <div style={{ marginTop: "var(--space-4)" }}>
        <button type="submit" className="button-primary" disabled={pending}>
          {pending ? "Sending…" : "Send application"}
        </button>
      </div>
    </form>
  );
}
