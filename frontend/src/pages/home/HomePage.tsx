import { Link } from "react-router";

/**
 * A temporary home page (Task list: "a temporary home linking to the
 * seeded providers until Story 3.2 replaces it"). This is deliberately not
 * a discovery list: no search, filters or category tabs (the spec's own
 * Never list reserves that for Stories 3.2/3.3) -- just plain links to
 * `npm run -w backend seed:demo`'s deterministic provider ids, so the demo
 * can be opened in a browser today.
 */
const SEEDED_PROVIDERS = [
  { id: "demo-marmara-hair-clinic", label: "Marmara Hair Clinic -- Hair transplant consult (Istanbul)" },
  { id: "demo-elif-aydin", label: "Dr. Elif Aydın -- Clinical psychologist (Istanbul)" },
  { id: "demo-northside-barber", label: "Northside Barber -- Cut and beard (Istanbul)" },
  { id: "demo-atelier-lale", label: "Atelier Lale -- Beauty salon (Istanbul)" },
  { id: "demo-kaan-demir", label: "Kaan Demir -- Startup strategy consulting" },
  { id: "demo-mehmet-can-yilmaz", label: "Mehmet Can Yılmaz -- Executive coaching" },
  { id: "demo-zeynep-aksoy", label: "Zeynep Aksoy -- Turkish language tutor" },
];

export function HomePage() {
  return (
    <div className="page">
      <h1>Pactly</h1>
      <p>Trust-backed bookings. The deposit waits in a contract neither side controls.</p>
      <p>
        Run <code>npm run -w backend seed:demo</code> first, then open a provider below.
      </p>
      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {SEEDED_PROVIDERS.map((provider) => (
          <li key={provider.id}>
            <Link to={`/providers/${provider.id}`} className="button-ghost" style={{ textDecoration: "none" }}>
              {provider.label}
            </Link>
          </li>
        ))}
      </ul>
      <p>
        Are you one of the seeded providers, or set <code>SEED_PROVIDER_WALLET</code> to your own wallet?{" "}
        <Link to="/panel/availability">Open the availability panel</Link>.
      </p>
    </div>
  );
}
