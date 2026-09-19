import { Link, Route, Routes } from "react-router";

import { DiscoverPage } from "./pages/discover/DiscoverPage";
import { ProviderProfilePage } from "./pages/provider/ProviderProfilePage";
import { AvailabilityPage } from "./pages/panel/AvailabilityPage";
import { BookingsPage } from "./pages/panel/BookingsPage";
import { BookingPage } from "./pages/booking/BookingPage";
import { MyBookingsPage } from "./pages/my-bookings/MyBookingsPage";
import { ResolutionsPage } from "./pages/admin/ResolutionsPage";

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
        <Link to="/me/bookings">My bookings</Link>
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
        <Route path="/book/:providerId" element={<BookingPage />} />
        <Route path="/me/bookings" element={<MyBookingsPage />} />
        <Route path="/panel/availability" element={<AvailabilityPage />} />
        <Route path="/panel/bookings" element={<BookingsPage />} />
        <Route path="/admin/resolutions" element={<ResolutionsPage />} />
      </Routes>
    </>
  );
}
