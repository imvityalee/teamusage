/**
 * The limits and naming rules that the server, the client and the dashboard all apply: the server enforces them and the
 * others check the same ones before they send anything, so they can never disagree. Limits only the server needs (such
 * as the request body size) stay with it. Lengths are in UTF-16 code units (String.length).
 */

// Uploads. The bounds keep any number of rows far from SQLite's integer overflow and every sum finite.
export const MAX_BATCH = 1000;
export const MAX_TOKENS = 1e12; // each of input, output, cacheCreate, cacheRead
export const MAX_TOTAL_TOKENS = 4e12;
export const MAX_COST_USD = 1e7;

// Names, short enough to show.
export const MAX_AGENT_CHARS = 64;
export const MAX_MODEL_CHARS = 128;
export const MAX_ORG_CHARS = 100;
/** Longest member name or machine label, once trimmed. */
export const MAX_DISPLAY_NAME_CHARS = 100;
export const MAX_EMAIL_CHARS = 254;
/** Control characters refused in every name. */
export const NAME_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// Stats requests.
/** Longest date range one stats request may ask for, in days, both ends included. */
export const MAX_RANGE_DAYS = 730;
/** Most values of each repeated filter parameter (`agent`, `model`, `account`, `plan`) one stats request accepts. */
export const MAX_AGENT_FILTERS = 20;
export const MAX_MODEL_FILTERS = 50;
export const MAX_ACCOUNT_FILTERS = 50;
export const MAX_PLAN_FILTERS = 50;

/** An agent, model or organisation name: 1 to `max` characters, no control characters. */
export function isName(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !NAME_CONTROL_CHARS.test(v);
}

/** A member name or machine label: 1 to MAX_DISPLAY_NAME_CHARS characters once trimmed, no control characters. */
export function isDisplayName(v: unknown): v is string {
  if (typeof v !== "string" || NAME_CONTROL_CHARS.test(v)) return false;
  const length = v.trim().length;
  return length >= 1 && length <= MAX_DISPLAY_NAME_CHARS;
}

/** An email as registration accepts it: contains "@", at most MAX_EMAIL_CHARS characters, no control characters. */
export function isEmail(v: unknown): v is string {
  return typeof v === "string" && v.includes("@") && v.length <= MAX_EMAIL_CHARS && !NAME_CONTROL_CHARS.test(v);
}
