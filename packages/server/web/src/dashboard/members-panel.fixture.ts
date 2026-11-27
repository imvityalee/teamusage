import type { Stats } from "@teamusage/shared";
import { renderStats } from "../render.js";
import { newDocument, TODAY, who } from "../render.fixture.js";
import { chooseSize } from "../site/pager.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { statsFixture } from "../test-fixtures.js";
import { applyMemberSearch, type MembersTable } from "./members-panel.js";

/** A team of any size drawn into a members panel, and the ways a person works it (tests only). */

export const SIZE = 2000;
/** The no-break space that this runtime's Russian number format writes between thousands (U+00A0). */
const NBSP = " ";

/** `count` members from the worst-case people: member i has i in its name, `count - i` x 10 tokens, and most have synced. */
export function team(count = SIZE): Stats {
  const base = statsFixture();
  const members = Array.from({ length: count }, (_, i): Stats["members"][number] => {
    const person = worstCase.people[i % worstCase.people.length] as { name: string; email: string };
    return {
      id: i + 1,
      name: `${person.name} ${i + 1}`,
      email: `${i + 1}.${person.email}`,
      tokens: (count - i) * 10,
      costUsd: (i * 7) % 13,
      machines: 1,
      lastSyncAt: i % 10 === 9 ? null : "2026-11-17T08:00:00.000Z",
      byAgent: { claude: (count - i) * 10 },
      byAccount: {},
      byAccountPlan: [],
    };
  });
  return { ...base, totals: { ...base.totals, memberCount: count }, members };
}

export function mount(stats = team(), opts: { lang?: "en" | "ru"; table?: MembersTable; query?: string } = {}) {
  const doc = newDocument();
  const host = doc.createElement("div");
  doc.body.append(host); // connected, so that focus can be read back
  host.append(renderStats(doc, stats, opts.lang ?? "en", TODAY, { query: opts.query, table: opts.table }));
  const view = {
    doc,
    host,
    names: () => [...host.querySelectorAll("#members tbody tr")].map((r) => who(r)[1]),
    count: () => host.querySelectorAll("#members tbody tr").length,
    range: () => host.querySelector(".pager-range")?.textContent,
    count_line: () => host.querySelector("#members-count")?.textContent,
    press: (selector: string) => (host.querySelector(selector) as HTMLElement).click(),
    next: () => view.press('.pager button[data-step="next"]'),
    sortBy: (by: string) => view.press(`#members th button[data-sort="${by}"]`),
    th: (by: string) => host.querySelector(`#members th:has(button[data-sort="${by}"])`) as HTMLElement,
    choose(size: string) {
      const select = host.querySelector<HTMLSelectElement>(".pager select")!;
      chooseSize(select, size);
    },
    search: (query: string, stats: Stats = team()) => applyMemberSearch(doc, host, stats, "en", TODAY, query),
  };
  return view;
}
