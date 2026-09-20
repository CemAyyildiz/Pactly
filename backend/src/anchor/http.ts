/**
 * Shared fetch seam and error-body helpers for the anchor's SEP clients
 * (SEP-10 already has its own copies; SEP-12 and SEP-6 share these so a
 * 502 page never escapes as a raw JSON parse error).
 */
export type AnchorFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

const REQUEST_TIMEOUT_MS = 10_000;

export function defaultAnchorFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Pick<Response, "ok" | "status" | "json" | "text">> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export function anchorReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  return undefined;
}

export async function anchorReasonFromResponse(response: Pick<Response, "text">): Promise<string | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (text.trim() === "") return undefined;
  try {
    return anchorReason(JSON.parse(text)) ?? text.trim();
  } catch {
    return text.trim();
  }
}

export async function tryReadJson(response: Pick<Response, "json">): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
