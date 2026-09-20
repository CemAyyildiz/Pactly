import type { ReactNode } from "react";

export interface PageMastheadProps {
  /** Small uppercase line above the title (the page's "section" in the
   * product: "Provider panel", "Pactly admin"). */
  eyebrow?: string;
  /** Phosphor icon rendered before the eyebrow text. */
  icon?: ReactNode;
  title: string;
  /** Serif italic lede under the title. */
  lede?: ReactNode;
  /** Right-aligned controls on the title row (sign out, sibling links). */
  actions?: ReactNode;
}

/** The "Editorial Warmth" page header every non-Discover screen shares:
 * eyebrow, serif title, optional lede and a right-hand actions slot.
 * Discover renders its own larger masthead inline; this is the compact
 * sibling (`.editorial-masthead--page`). */
export function PageMasthead({ eyebrow, icon, title, lede, actions }: PageMastheadProps) {
  return (
    <header className="editorial-masthead editorial-masthead--page">
      {eyebrow ? (
        <span className="editorial-masthead__eyebrow">
          {icon}
          {eyebrow}
        </span>
      ) : null}
      <div className="editorial-masthead__row">
        <h1>{title}</h1>
        {actions ? <div className="editorial-masthead__actions">{actions}</div> : null}
      </div>
      {lede ? <p className="editorial-masthead__sub">{lede}</p> : null}
    </header>
  );
}
