/** Number, money, date and name formatting. Numbers always use the English grouping, as in the mockup. */

const DAY_MS = 86_400_000;

/** 2936526460 → "2,936,526,460" */
export function full(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

interface Unit {
  suffix: string;
  scale: number;
  digits: number;
}

/** The units of `compact`, largest first, with the decimals each shows. */
const UNITS: readonly Unit[] = [
  { suffix: "Q", scale: 1e15, digits: 2 },
  { suffix: "T", scale: 1e12, digits: 2 },
  { suffix: "B", scale: 1e9, digits: 2 },
  { suffix: "M", scale: 1e6, digits: 1 },
];

/** `n` in `unit`, rounded to the decimals the unit shows, half away from zero. */
const inUnit = (n: number, unit: Unit): number => (Math.sign(n) * Math.round(Math.abs(n) / (unit.scale / 10 ** unit.digits))) / 10 ** unit.digits;

/**
 * 9007199254740991 → "9.01Q", 4031300000000 → "4.03T", 2936526460 → "2.94B", 44200000 → "44.2M", 950 → "950".
 * A number moves up a unit once the unit below would show 1000 after rounding (999,995,000,000,000 → "1.00Q").
 * Q is the top: Number.MAX_SAFE_INTEGER reads "9.01Q", and a total above it is no longer an exact integer.
 */
export function compact(n: number): string {
  for (const [i, unit] of UNITS.entries()) {
    const below = UNITS[i + 1];
    const reached = below === undefined ? Math.abs(n) >= unit.scale : Math.abs(inUnit(n, below)) >= 1000;
    if (reached) return inUnit(n, unit).toFixed(unit.digits) + unit.suffix;
  }
  return full(n);
}

/** 2023.09 → "$2,023.09" */
export function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A YYYY-MM-DD calendar date as a local Date at midnight. */
function calendarDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Whole local calendar days from the day of `timestamp` to `today` (YYYY-MM-DD); null when unparseable. */
export function daysSince(timestamp: string, today: string): number | null {
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return null;
  const a = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  const b = calendarDate(today);
  const days = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - a) / DAY_MS);
  return Math.max(0, days);
}

/** "2026-11-18" → "Nov 18" (en-US) or "18 нояб." (ru-RU). */
export function shortDate(iso: string, locale: string): string {
  return calendarDate(iso).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** "2026-11-18" → "Nov 18, 2026" or "18 нояб. 2026 г." */
export function longDate(iso: string, locale: string): string {
  return calendarDate(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** "21 Aug – 18 Nov 2026" in one year, "18 Nov 2025 – 3 Feb 2026" across years; month names follow the locale. */
export function rangeText(from: string, to: string, locale: string): string {
  const start = calendarDate(from);
  const sameYear = start.getFullYear() === calendarDate(to).getFullYear();
  const first = sameYear ? start.toLocaleDateString(locale, { day: "numeric", month: "short" }) : longDate(from, locale);
  return `${first} – ${longDate(to, locale)}`;
}

const LETTER = /\p{L}/u;

/** Avatar initials: the first letter of each of the first two words that have one ("Айгерим Садыкова" → "АС"), or "?". */
export function initials(name: string): string {
  const letters: string[] = [];
  for (const word of String(name).split(/\s+/)) {
    const first = [...word].find((c) => LETTER.test(c));
    if (first !== undefined) letters.push(first);
    if (letters.length === 2) break;
  }
  if (letters.length === 0) return "?";
  // A letter whose capital is longer ("ß" → "SS") stays as it is, so the avatar never exceeds two characters.
  return letters.map((c) => ([...c.toUpperCase()].length === 1 ? c.toUpperCase() : c)).join("");
}
