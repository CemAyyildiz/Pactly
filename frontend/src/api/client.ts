/**
 * Typed fetch client for `/api/*` (proxied to the backend by
 * `vite.config.ts`, prefix stripped, so the browser never hits CORS). The
 * one place a non-2xx response is turned into a typed {@link ApiError}
 * carrying the backend's own `{code, message, details?}` envelope (AD-11)
 * -- every screen catches this shape, never a raw `Response`.
 */

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(envelope: ApiErrorEnvelope, status: number) {
    super(envelope.message);
    this.name = "ApiError";
    this.code = envelope.code;
    this.status = status;
    this.details = envelope.details;
  }
}

function authHeaders(token?: string): HeadersInit | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const envelope = await response
      .json()
      .catch(() => ({ code: "unknown_error", message: "Connection dropped. Your deposit is untouched." }));
    throw new ApiError(envelope as ApiErrorEnvelope, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function apiGet<T>(path: string, token?: string): Promise<T> {
  return request<T>(path, { headers: authHeaders(token) });
}

export function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>(path, { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>(path, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(body) });
}
