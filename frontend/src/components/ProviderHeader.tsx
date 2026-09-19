export interface ProviderHeaderProps {
  displayName: string;
  title: string;
  location: string;
  categoryName: string;
  isApproved: boolean;
  verifiedSessionCount: number;
}

/** DESIGN.md: deep teal is the provider's identity block and is never
 * interactive -- name, title, location, and the two badges only. */
export function ProviderHeader({
  displayName,
  title,
  location,
  categoryName,
  isApproved,
  verifiedSessionCount,
}: ProviderHeaderProps) {
  return (
    <header className="provider-header">
      <div className="provider-header__badges">
        {isApproved && <span className="badge badge--approved">Approved provider</span>}
        <span className="badge badge--verified">{verifiedSessionCount} verified sessions</span>
      </div>
      <h1 className="provider-header__name">{displayName}</h1>
      <p className="provider-header__title">
        {title} · {categoryName}
      </p>
      <p className="provider-header__location">{location}</p>
    </header>
  );
}
