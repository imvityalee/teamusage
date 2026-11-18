/** Number, money, date and name formatting. Numbers always use the English grouping, as in the mockup. */

const DAY_MS = 86_400_000;

/** 2936526460 → "2,936,526,460" */
export function full(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 2936526460 → "2.94B", 44200000 → "44.2M", 950 → "950" */
export function compact(n: number): string {
  const millions = Math.round(n / 1e5) / 10;
  if (Math.abs(millions) >= 1000) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return millions.toFixed(1) + "M";
  return full(n);
}

/** 2023.09 → "$2,023.09" */
export function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The local calendar day of `d` as YYYY-MM-DD. */
export function localIsoDate(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
