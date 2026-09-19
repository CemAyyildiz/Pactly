/** The one place `sessionFormat`'s raw backend value ("video" | "in_person")
 * becomes a human label -- shared by the provider card and the profile page
 * so the two screens can never drift into different wording for the same
 * value. */
const SESSION_FORMAT_LABEL: Record<string, string> = {
  video: "Video call",
  in_person: "In person",
};

export function formatSessionFormat(sessionFormat: string): string {
  return SESSION_FORMAT_LABEL[sessionFormat] ?? sessionFormat;
}
