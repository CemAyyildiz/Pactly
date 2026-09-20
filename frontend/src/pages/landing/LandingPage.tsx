import { Link } from "react-router";

import { providerPhotoSrc } from "../../lib/providerPhotos";

/** The four seeded categories (`backend/src/seed/demoData.ts`), named here
 * instead of fetched: the landing page renders before any API call and
 * must never block on one just to draw four static tiles. Each one points
 * at a real seeded provider's photo (`providerId`) so the tile shows an
 * actual listing rather than an invented stock image. */
const CATEGORIES: Array<{ slug: string; name: string; providerId: string }> = [
  { slug: "therapy-and-wellbeing", name: "Therapy and wellbeing", providerId: "demo-elif-aydin" },
  { slug: "fitness-and-beauty", name: "Fitness and beauty", providerId: "demo-northside-barber" },
  { slug: "consulting", name: "Consulting", providerId: "demo-kaan-demir" },
  { slug: "education-and-lessons", name: "Education and lessons", providerId: "demo-zeynep-aksoy" },
];

function CalendarIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="16" rx="2.5" />
      <path d="M16 2.5v4M8 2.5v4M3.5 10h17" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9.5" rx="2.5" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </svg>
  );
}

function CheckShieldIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5.5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4.5" />
    </svg>
  );
}

/**
 * `/` -- the marketing landing page. `/discover` carries the marketplace
 * itself (moved there so this page could take the root path); every button
 * here either sends a visitor into that flow or into the provider panel.
 */
export function LandingPage() {
  const storyPhoto = providerPhotoSrc("demo-marmara-hair-clinic");
  const heroPhoto = providerPhotoSrc("demo-atelier-lale");

  return (
    <div className="landing">
      <section className="landing__hero">
        <div className="landing__hero-inner">
          <div>
            <div className="landing__kicker">
              <span className="landing__kicker-dot" />
              Rise In × Stellar Pro Hackathon 2026 · Genesis Track
            </div>
            <h1>
              Book the appointment.
              <br />
              Trust <span className="landing__highlight">the deposit</span>.
            </h1>
            <p className="landing__lede">
              Pactly is a booking marketplace where the deposit sits in an escrow neither the client nor the
              provider controls. It releases when the appointment happens, or back to the client on a timely
              cancellation — with a transparent resolution path when the two sides disagree.
            </p>
            <div className="landing__hero-ctas">
              <Link to="/discover" className="button-primary" style={{ textDecoration: "none" }}>
                Explore providers
              </Link>
              <Link to="/panel/availability" className="button-ghost" style={{ textDecoration: "none" }}>
                List your shop
              </Link>
            </div>
            <div className="landing__hero-trust">
              <span className="landing__hero-trust-item">
                <b>No blind prepay</b> — deposit waits in escrow
              </span>
              <span className="landing__hero-trust-item">
                <b>Clear policy</b> for cancellations and no-shows
              </span>
              <span className="landing__hero-trust-item landing__hero-trust-item--live">Trustless Work escrow · operational</span>
            </div>
          </div>

          <div className="landing__hero-visual">
            {heroPhoto ? <img className="landing__hero-photo" src={heroPhoto} alt="" aria-hidden="true" /> : null}
            <div className="card landing__mock-card">
              <div className="eyebrow-label">Upcoming appointment</div>
              <p className="landing__mock-name">Marmara Hair Clinic</p>
              <p className="landing__mock-meta">Consultation · Istanbul · Fri 14:00</p>
              <div className="deposit-pill">
                <span className="deposit-pill__amount">50 USDC</span>{" "}
                <span className="deposit-pill__caption">deposit · free cancellation until Thu 14:00</span>
              </div>
              <div className="landing__mock-status">
                <span className="state-label state-label--positive">Funded</span>
                <span className="landing__mock-status-arrow">→</span>
                <span className="state-label">Released on completion</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing__section landing__section--white">
        <div className="landing__section-inner">
          <div className="landing__section-head">
            <div className="eyebrow-label">How it works</div>
            <h2>Three steps, both sides covered</h2>
          </div>
          <div className="landing__steps">
            <div className="landing__step">
              <span className="landing__step-num-ghost">01</span>
              <div className="landing__step-icon">
                <CalendarIcon />
              </div>
              <h3>Discover and hold a slot</h3>
              <p>Browse categories, pick an open slot, and hold it — no wallet needed yet.</p>
            </div>
            <div className="landing__step">
              <span className="landing__step-num-ghost">02</span>
              <div className="landing__step-icon">
                <LockIcon />
              </div>
              <h3>Lock a deposit in escrow</h3>
              <p>
                Connect a wallet and lock USDC, or pay in through a TRY bank transfer. Trustless Work holds the
                deposit — not Pactly, not the provider.
              </p>
            </div>
            <div className="landing__step">
              <span className="landing__step-num-ghost">03</span>
              <div className="landing__step-icon">
                <CheckShieldIcon />
              </div>
              <h3>Appointment happens, deposit releases</h3>
              <p>
                Provider marks it complete, client approves, deposit releases. Either side can open a dispute
                first for a transparent, chain-backed resolution.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing__section landing__story">
        <div className="landing__section-inner landing__story-inner">
          {storyPhoto ? (
            <img className="landing__story-photo" src={storyPhoto} alt="Marmara Hair Clinic, Istanbul" />
          ) : null}
          <div>
            <div className="eyebrow-label">The demo scenario</div>
            <p className="landing__story-quote">
              Aisha, a client abroad, locks a meaningful deposit for an in-person hair-transplant consultation at
              Marmara Hair Clinic in Istanbul — sight unseen, without wiring money to a stranger's bank account.
            </p>
            <p className="landing__story-byline">
              Therapy, barber, salon, consulting and language-tutoring listings sit alongside it: Pactly isn't
              built for one profession.
            </p>
          </div>
        </div>
      </section>

      <section className="landing__section landing__section--white">
        <div className="landing__section-inner">
          <div className="landing__section-head">
            <div className="eyebrow-label">Browse by category</div>
            <h2>Any appointment-based service</h2>
          </div>
          <div className="landing__categories">
            {CATEGORIES.map((category) => {
              const photo = providerPhotoSrc(category.providerId);
              return (
                <Link key={category.slug} to={`/discover?category=${category.slug}`} className="landing__category-card">
                  {photo ? <img className="landing__category-photo" src={photo} alt="" aria-hidden="true" /> : null}
                  <span className="landing__category-label">{category.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="landing__section">
        <div className="landing__section-inner">
          <div className="eyebrow-label">Built with</div>
          <div className="landing__badges">
            <span className="landing__badge">Stellar testnet</span>
            <span className="landing__badge">
              <a href="https://www.trustlesswork.com/" target="_blank" rel="noreferrer">
                Trustless Work escrow
              </a>
            </span>
            <span className="landing__badge">USDC</span>
            <span className="landing__badge">SEP-6 anchor · TRY sandbox</span>
          </div>
        </div>
      </section>

      <section className="landing__cta-band">
        <div className="landing__section-inner">
          <h2>Ready to book with confidence?</h2>
          <p>No blind prepay, no wired-money leap of faith — just a deposit that waits for the appointment.</p>
          <div className="landing__hero-ctas">
            <Link to="/discover" className="button-primary" style={{ textDecoration: "none" }}>
              Explore providers
            </Link>
            <Link to="/panel/availability" className="landing__cta-ghost" style={{ textDecoration: "none" }}>
              List your shop
            </Link>
          </div>
        </div>
      </section>

      <footer className="landing__footer">
        <div className="landing__section-inner landing__footer-inner">
          <span>Built for the Rise In × Stellar Pro Hackathon 2026 — Genesis Track.</span>
          <span>Escrow powered by Trustless Work · Stellar testnet</span>
        </div>
      </footer>
    </div>
  );
}
