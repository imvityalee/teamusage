/**
 * Filters the members already on the page. The query is only ever compared as a plain substring:
 * it is never a regular expression, never markup, never sent anywhere and never stored.
 */
export function matchMembers<T extends { name: string; email: string }>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...members];
  return members.filter((m) => String(m.name).toLowerCase().includes(q) || String(m.email).toLowerCase().includes(q));
}
