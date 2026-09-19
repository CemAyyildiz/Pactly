/** DESIGN.md's `seal-locked`: the circular mark stamped on confirmation,
 * used at that moment only. CSS drives the "meeting" and "seal" motion
 * (a scale-in), gated behind `prefers-reduced-motion: no-preference` in
 * `base.css` -- under reduced motion the seal simply appears in its final
 * state (EXPERIENCE.md: "the seal appears in its final state"). */
export function Seal() {
  return (
    <div className="seal" role="img" aria-label="Locked with Pactly">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    </div>
  );
}
