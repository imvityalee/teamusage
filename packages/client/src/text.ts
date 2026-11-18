const MAX_TEXT = 200;

/** Server-supplied text is data: control, bidi and zero-width characters removed, at most 200 code points. */
export function clean(v: unknown): string {
  return Array.from(
    String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ""),
  )
    .slice(0, MAX_TEXT)
    .join("");
}
