/** Talks to the server for the new pages. Same-origin paths only; the session cookie is the only credential. */

export type ApiResult<T> =
  | { kind: "ok"; value: T } // 2xx; `value` is undefined for 204
  | { kind: "unauthorized" } // 401
  // any other 4xx, 503 and 507; `error` is the server's own text (at most MAX_ERROR_CHARS), or "" when the body is not
  // a JSON object with a string `error` (a proxy's HTML page, a self-hosted 404 in plain text)
  | { kind: "refused"; status: number; error: string; retryAfterSec?: number }
  | { kind: "failed" } // any other status, or a 2xx whose body is not JSON
  | { kind: "network" };

/** The longest refusal text a page may draw inside its own sentence; a longer one is cut and ends in "…". */
export const MAX_ERROR_CHARS = 300;

/** The statuses whose answer is the server's own refusal, to be shown in the page's words. */
const isRefusal = (status: number): boolean => (status >= 400 && status < 500) || status === 503 || status === 507;

/** `text` cut to MAX_ERROR_CHARS characters, never through the middle of one. */
function capped(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_ERROR_CHARS ? text : `${chars.slice(0, MAX_ERROR_CHARS - 1).join("")}…`;
}

/** The server's text of a refusal: the string `error` of a JSON object; "" for any other body. */
async function refusalText(res: Response): Promise<string> {
  try {
    const error = ((await res.json()) as { error?: unknown } | null)?.error;
    return typeof error === "string" ? capped(error) : "";
  } catch {
    return ""; // not JSON, or the body could not be read
  }
}

/** Seconds of a `Retry-After` that counts them; undefined otherwise. */
function retryAfter(res: Response): number | undefined {
  const value = res.headers.get("Retry-After");
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

async function refused(res: Response): Promise<ApiResult<never>> {
  const error = await refusalText(res);
  const seconds = retryAfter(res);
  return seconds === undefined ? { kind: "refused", status: res.status, error } : { kind: "refused", status: res.status, error, retryAfterSec: seconds };
}

async function okValue<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 204) return { kind: "ok", value: undefined as T };
  try {
    return { kind: "ok", value: (await res.json()) as T };
  } catch {
    return { kind: "failed" };
  }
}

/** One same-origin request with a JSON body and a JSON answer. `path` is fixed text or built from checked ids. */
export async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { kind: "network" };
  }
  if (res.ok) return okValue<T>(res);
  if (res.status === 401) return { kind: "unauthorized" };
  if (isRefusal(res.status)) return refused(res);
  return { kind: "failed" };
}
