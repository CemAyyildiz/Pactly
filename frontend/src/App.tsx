import { Link, Route, Routes } from "react-router";

import { DiscoverPage } from "./pages/discover/DiscoverPage";
import { ProviderProfilePage } from "./pages/provider/ProviderProfilePage";
import { AvailabilityPage } from "./pages/panel/AvailabilityPage";

/** The minimal top bar every screen shares (Task list): brand, and the
 * escrow-provenance note DESIGN.md/EXPERIENCE.md require to be visible
 * even before any booking exists. */
function TopBar() {
  return (
    <div className="top-bar">
      <Link to="/" className="top-bar__brand">
        Pactly
      </Link>
      <span className="top-bar__escrow-note">Escrow powered by Trustless Work · Stellar</span>
      <nav className="top-bar__nav">
        <Link to="/panel/availability">Provider panel</Link>
      </nav>
    </div>
  );
}

export function App() {
  return (
    <>
      <TopBar />
      <Routes>
        <Route path="/" element={<DiscoverPage />} />
        <Route path="/providers/:id" element={<ProviderProfilePage />} />
        <Route path="/panel/availability" element={<AvailabilityPage />} />
      </Routes>
    </>
  );
}
