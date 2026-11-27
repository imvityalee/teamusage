import type { Stats } from "@teamusage/shared";
import { statsUrl, type Source } from "./dashboard/source.js";
import { cleanAvailable, NO_FILTERS, toQuery, type Filters } from "./filters.js";
import { isMemberId } from "./route.js";

/** Talks to the server. Same-origin relative URLs only; the session cookie is the only credential. */

export type StatsResult =
  | { kind: "ok"; stats: Stats }
  | { kind: "unauthorized" }
  | { kind: "notFound" }
  | { kind: "noTeam" } // a 404 "team not found": the team does not exist, or the session has no role in it
  | { kind: "busy"; retryAfterSec: number } // a 429 whose body has "limit": "team-stats"
  | { kind: "error"; message: string }
  | { kind: "network" }
  | { kind: "aborted" };

export type LoginResult =
  | { kind: "ok" }
  | { kind: "wrong" }
  | { kind: "wrongAddress" } // a 403 "cross-site request refused": the page is not at the address the server signs in from
  | { kind: "tooMany"; retryAfterSec: number }
  | { kind: "error" }
  | { kind: "network" };

const DEFAULT_RETRY_AFTER_SEC = 60;
/** The server's text of a 404 for a team that does not exist or that the session has no role in. */
const TEAM_NOT_FOUND = "team not found";
/** The server's text of a 403 for a request from another origin than its own. */
const CROSS_SITE = "cross-site request refused";

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

/** The JSON body of a refusal, or an empty object when it is not JSON. */
async function refusalBody(res: Response): Promise<{ error?: unknown; limit?: unknown }> {
  try {
    const body = (await res.json()) as unknown;
    return typeof body === "object" && body !== null ? body : {};
  } catch {
    return {};
  }
}

/** Seconds of a `Retry-After` that counts them; DEFAULT_RETRY_AFTER_SEC otherwise. */
function retryAfterSec(res: Response): number {
  const header = res.headers.get("Retry-After") ?? "";
  return /^\d+$/.test(header) ? Number(header) : DEFAULT_RETRY_AFTER_SEC;
}

/** What a refused statistics request means to the page. */
async function statsRefusal(res: Response, member: number | undefined): Promise<StatsResult> {
  const { error, limit } = await refusalBody(res);
  if (res.status === 429 && limit === "team-stats") return { kind: "busy", retryAfterSec: retryAfterSec(res) };
  if (res.status === 404 && error === TEAM_NOT_FOUND) return { kind: "noTeam" };
  if (res.status === 404 && member !== undefined) return { kind: "notFound" };
  return { kind: "error", message: typeof error === "string" ? error : `HTTP ${res.status}` };
}

/**
 * The team's stats for the range, or one member's when `member` is given, narrowed by the agent, model, account and plan filters,
 * from `source` (a self-hosted server's when none is given). Every value is encoded by URLSearchParams; the path is fixed.
 */
export async function fetchStats(
  from: string,
  to: string,
  signal?: AbortSignal,
  member?: number,
  filters: Filters = NO_FILTERS,
  source: Source = { kind: "selfHosted" },
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
    res = await fetch(statsUrl(source, query), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    return isAbort(err) ? { kind: "aborted" } : { kind: "network" };
  }
  try {
    if (res.status === 401) return { kind: "unauthorized" };
    if (!res.ok) return await statsRefusal(res, member);
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
  if (res.status === 403) return (await refusalBody(res)).error === CROSS_SITE ? { kind: "wrongAddress" } : { kind: "wrong" };
  if (res.status === 429) return { kind: "tooMany", retryAfterSec: retryAfterSec(res) };
  return { kind: "error" };
}
