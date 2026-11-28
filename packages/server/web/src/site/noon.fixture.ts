/** A time on the local day `iso` (`YYYY-MM-DD`) at noon, so a day count is the same in every time zone (tests only). */
export const noon = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).toISOString();
};
