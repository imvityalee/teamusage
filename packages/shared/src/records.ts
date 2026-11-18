import { validateAccount, type AccountLabel } from "./account.js";

export interface UsageRecord {
  date: string; // YYYY-MM-DD, the machine's local day
  agent: string; // ccusage agent id, e.g. "claude", "codex"
  model: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number; // input + output + cacheCreate + cacheRead
  costUsd: number;
  unpriced: boolean;
  account?: AccountLabel; // Claude records only
}

export const MAX_BATCH = 1000;

/**
 * Upload bounds. They keep any number of rows far from SQLite's integer overflow and every sum finite,
 * and keep names short enough to show. Lengths are in UTF-16 code units (String.length).
 */
export const MAX_TOKENS = 1e12; // each of input, output, cacheCreate, cacheRead
export const MAX_TOTAL_TOKENS = 4e12;
export const MAX_COST_USD = 1e7;
export const MAX_AGENT_CHARS = 64;
export const MAX_MODEL_CHARS = 128;
/** Control characters refused in agent and model names. */
export const NAME_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

type BatchResult = { ok: true; records: UsageRecord[] } | { ok: false; error: string };

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const isCount = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const isName = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !NAME_CONTROL_CHARS.test(v);

function validateRecord(raw: unknown): UsageRecord | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not an object";
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== "string" || !isRealDate(r.date)) return "invalid date";
  if (!isName(r.agent, MAX_AGENT_CHARS)) return "invalid agent";
  if (!isName(r.model, MAX_MODEL_CHARS)) return "invalid model";
  const { input, output, cacheCreate, cacheRead, total, costUsd, unpriced } = r;
  if (
    !isCount(input, MAX_TOKENS) ||
    !isCount(output, MAX_TOKENS) ||
    !isCount(cacheCreate, MAX_TOKENS) ||
    !isCount(cacheRead, MAX_TOKENS) ||
    !isCount(total, MAX_TOTAL_TOKENS)
  ) {
    return "token counts must be non-negative integers within the upload limits";
  }
  if (total !== input + output + cacheCreate + cacheRead) return "total is not the sum of the token counts";
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > MAX_COST_USD) {
    return "invalid costUsd";
  }
  if (typeof unpriced !== "boolean") return "invalid unpriced";
  const rec: UsageRecord = { date: r.date, agent: r.agent, model: r.model, input, output, cacheCreate, cacheRead, total, costUsd, unpriced };
  if (r.account !== undefined) {
    if (r.agent !== "claude") return "account on a non-claude record";
    const account = validateAccount(r.account);
    if (typeof account === "string") return account;
    rec.account = account;
  }
  return rec;
}

/** Never throws: any malformed input yields `{ ok: false }`. */
export function validateBatch(body: unknown): BatchResult {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, error: "body must be an object" };
    }
    const list = (body as Record<string, unknown>).records;
    if (!Array.isArray(list)) return { ok: false, error: "records must be an array" };
    if (list.length > MAX_BATCH) return { ok: false, error: `at most ${MAX_BATCH} records per batch` };
    const records: UsageRecord[] = [];
    for (let i = 0; i < list.length; i++) {
      const res = validateRecord(list[i]);
      if (typeof res === "string") return { ok: false, error: `records[${i}]: ${res}` };
      records.push(res);
    }
    return { ok: true, records };
  } catch {
    return { ok: false, error: "malformed body" };
  }
}
