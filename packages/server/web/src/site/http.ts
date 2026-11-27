/** Talks to the server for the new pages. Same-origin paths only; the session cookie is the only credential. */

export type ApiResult<T> =
  | { kind: "ok"; value: T } // 2xx; `value` is undefined for 204
  | { kind: "unauthorized" } // 401
  | { kind: "refused"; status: number; error: string; retryAfterSec?: number } // any other 4xx, 503 and 507; `error` is the server's text
  | { kind: "failed" } // any other status, or a body that is not JSON
  | { kind: "network" };

/** The statuses whose answer is the server's own refusal, to be shown in the page's words. */
const isRefusal = (status: number): boolean => (status >= 400 && status < 500) || status === 503 || status === 507;

/** The server's text of a refusal: `error` of a JSON body, otherwise the body as it is (a self-hosted 404 is plain text). */
async function refusalText(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON, or the body could not be read: the text read so far is the answer.
  }
  return text.trim();
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
