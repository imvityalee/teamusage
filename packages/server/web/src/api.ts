import type { Stats } from "@teamusage/shared";
import { cleanAvailable, NO_FILTERS, toQuery, type Filters } from "./filters.js";
import { isMemberId } from "./route.js";

/** Talks to the server. Same-origin relative URLs only; the session cookie is the only credential. */

export type StatsResult =
  | { kind: "ok"; stats: Stats }
  | { kind: "unauthorized" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "network" }
  | { kind: "aborted" };

export type LoginResult =
  | { kind: "ok" }
  | { kind: "wrong" }
  | { kind: "tooMany"; retryAfterSec: number }
  | { kind: "error" }
  | { kind: "network" };

const DEFAULT_RETRY_AFTER_SEC = 60;

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

/**
 * Enough of the shape to render without throwing; values are still treated as untrusted text.
 * For one member, the answer must be about that member and list their machines.
 */
function looksLikeStats(v: unknown, member?: number): v is Stats {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  const totals = s.totals as Record<string, unknown> | null;
  const available = s.available as Record<string, unknown> | null;
  const shape =
    typeof s.from === "string" &&
    typeof s.to === "string" &&
    typeof totals === "object" &&
    totals !== null &&
    typeof totals.tokens === "number" &&
    Array.isArray(s.daily) &&
    Array.isArray(s.members) &&
    Array.isArray(s.models) &&
    typeof available === "object" &&
    available !== null &&
    Array.isArray(available.agents) &&
    Array.isArray(available.models);
  if (!shape || member === undefined) return shape;
  const members = s.members as unknown[];
  return (
    Array.isArray(s.machines) &&
    members.some((m) => typeof m === "object" && m !== null && (m as { id?: unknown }).id === member)
  );
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON: fall through to the status.
  }
  return `HTTP ${res.status}`;
}

/**
 * The team's stats for the range, or one member's when `member` is given, narrowed by the agent, model, account and plan filters.
 * Every value is encoded by URLSearchParams; the path is fixed.
 */
export async function fetchStats(
  from: string,
  to: string,
  signal?: AbortSignal,
  member?: number,
  filters: Filters = NO_FILTERS,
): Promise<StatsResult> {
  const query = new URLSearchParams({ from, to });
  if (member !== undefined) {
    // Only a checked number goes into the URL, written out by this code.
    if (!isMemberId(member)) return { kind: "error", message: "invalid member" };
    query.set("member", String(member));
  }
  for (const [key, value] of toQuery(filters)) query.append(key, value);
  let res: Response;
  try {
    res = await fetch(`/api/stats?${query}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    return isAbort(err) ? { kind: "aborted" } : { kind: "network" };
  }
  try {
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 404 && member !== undefined) return { kind: "notFound" };
    if (!res.ok) return { kind: "error", message: await errorMessage(res) };
    const body: unknown = await res.json();
    if (!looksLikeStats(body, member)) return { kind: "error", message: "unexpected response" };
    // The filter lists drive the controls and `prune`: keep only well-formed entries.
    return { kind: "ok", stats: { ...body, available: cleanAvailable(body.available) } };
  } catch (err) {
    return isAbort(err) ? { kind: "aborted" } : { kind: "error", message: "unexpected response" };
  }
}

/** Sends the invite code in the body of one POST and keeps nothing; the server answers with a session cookie. */
export async function login(inviteCode: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode }),
      cache: "no-store",
    });
  } catch {
    return { kind: "network" };
  }
  if (res.ok) return { kind: "ok" };
  if (res.status === 403) return { kind: "wrong" };
  if (res.status === 429) {
    const header = res.headers.get("Retry-After") ?? "";
    const sec = /^\d+$/.test(header) ? Number(header) : DEFAULT_RETRY_AFTER_SEC;
    return { kind: "tooMany", retryAfterSec: sec };
  }
  return { kind: "error" };
}
