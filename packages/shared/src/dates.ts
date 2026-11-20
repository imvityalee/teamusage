import { MAX_RANGE_DAYS } from "./limits.js";

// Calendar dates are YYYY-MM-DD strings, years 0000 to 9999. Arithmetic is done in UTC, so no time zone or DST
// shift applies.

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC midnight of a year, month (1-12) and day. Unlike Date.UTC, years 0 to 99 are not taken as 1900 to 1999. */
function utcDate(y: number, m: number, d: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date;
}

/** Epoch ms (UTC midnight) of a strict YYYY-MM-DD that is a real calendar date; undefined otherwise. */
export function parseIsoDate(s: string): number | undefined {
  const m = ISO_DATE.exec(s);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = utcDate(y, mo, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date.getTime() : undefined;
}

/** True for a strict YYYY-MM-DD that is a real calendar date. */
export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && parseIsoDate(s) !== undefined;
}

/** `iso` moved by `days` calendar days (negative goes back). `iso` and the result must be valid YYYY-MM-DD dates. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return utcDate(y, m, d + days).toISOString().slice(0, 10);
}

/** The number of days from `from` to `to`, both included (0 or less when `from` is after `to`). */
const inclusiveDays = (from: number, to: number): number => (to - from) / DAY_MS + 1;

/** Every date from `from` to `to`, both included; empty when `from` is after `to`. Throws on an invalid date. */
export function datesBetween(from: string, to: string): string[] {
  const f = parseIsoDate(from);
  const t = parseIsoDate(to);
  if (f === undefined || t === undefined) throw new RangeError("datesBetween needs two valid YYYY-MM-DD dates");
  return Array.from({ length: Math.max(0, inclusiveDays(f, t)) }, (_, i) => addDays(from, i));
}

/** The local calendar day of `d` as YYYY-MM-DD. */
export function localIsoDate(d: Date = new Date()): string {
  const pad = (v: number, width = 2) => String(v).padStart(width, "0");
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Inclusive range of exactly `days` days ending at `today` (YYYY-MM-DD). */
export function presetRange(days: 30 | 90 | 180, today: string): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}

/** Whether a stats request may ask for `from` to `to`: both real dates, in order, at most MAX_RANGE_DAYS days. */
export function checkRange(from: string, to: string): "ok" | "invalid" | "order" | "tooLong" {
  const f = parseIsoDate(from);
  const t = parseIsoDate(to);
  if (f === undefined || t === undefined) return "invalid";
  if (f > t) return "order";
  return inclusiveDays(f, t) > MAX_RANGE_DAYS ? "tooLong" : "ok";
}
