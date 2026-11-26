import { validateAccount, type AccountLabel } from "./account.js";
import { isIsoDate, isUsageDate } from "./dates.js";
import {
  isName,
  MAX_AGENT_CHARS,
  MAX_BATCH,
  MAX_COST_USD,
  MAX_MODEL_CHARS,
  MAX_TOKENS,
  MAX_TOTAL_TOKENS,
  MIN_USAGE_DATE,
} from "./limits.js";

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
  account?: AccountLabel; // Claude and Codex records only
}

export const DATE_OUT_OF_RANGE = `date must be from ${MIN_USAGE_DATE} to tomorrow`;

type BatchResult = { ok: true; records: UsageRecord[] } | { ok: false; error: string };

const isCount = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
function validateRecord(raw: unknown, now: Date): UsageRecord | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not an object";
  const r = raw as Record<string, unknown>;
  if (!isIsoDate(r.date)) return "invalid date";
  if (!isUsageDate(r.date, now)) return DATE_OUT_OF_RANGE;
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
    const account = validateAccount(r.account, r.agent);
    if (typeof account === "string") return account;
    rec.account = account;
  }
  return rec;
}

/** Never throws: any malformed input yields `{ ok: false }`. `now` decides which usage dates are accepted. */
export function validateBatch(body: unknown, now: Date = new Date()): BatchResult {
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, error: "body must be an object" };
    }
    const list = (body as Record<string, unknown>).records;
    if (!Array.isArray(list)) return { ok: false, error: "records must be an array" };
    if (list.length > MAX_BATCH) return { ok: false, error: `at most ${MAX_BATCH} records per batch` };
    const records: UsageRecord[] = [];
    for (let i = 0; i < list.length; i++) {
      const res = validateRecord(list[i], now);
      if (typeof res === "string") return { ok: false, error: `records[${i}]: ${res}` };
      records.push(res);
    }
    return { ok: true, records };
  } catch {
    return { ok: false, error: "malformed body" };
  }
}
