import type { Stats } from "@teamusage/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chooseSize } from "../site/pager.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { renderStats } from "../render.js";
import { newDocument, TODAY, who } from "../render.fixture.js";
import { statsFixture } from "../test-fixtures.js";
import { applyMemberSearch } from "./members-panel.js";
import type { MemberSort } from "./members-table.js";

/** What a team of two thousand makes of the members table: one page of rows, search and sorting over everyone. */

const SIZE = 2000;
/** The no-break space that this runtime's Russian number format writes between thousands (U+00A0). */
const NBSP = " ";

/** `count` members from the worst-case people: member i has i in its name, `count - i` x 10 tokens, and most have synced. */
function team(count = SIZE): Stats {
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

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

function mount(stats = team(), opts: { lang?: "en" | "ru"; sort?: MemberSort; onSort?: (s: MemberSort) => void; query?: string } = {}) {
  const doc = newDocument();
  const host = doc.createElement("div");
  host.append(renderStats(doc, stats, opts.lang ?? "en", TODAY, { query: opts.query, sort: opts.sort, onSort: opts.onSort }));
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

describe("one page of rows", () => {
  test("2,000 members draw 25 rows and a footer that counts them all", () => {
    const m = mount();
    expect(m.count()).toBe(25);
    expect(m.range()).toBe("1–25 of 2,000");
    expect(m.host.querySelectorAll("tr").length).toBeLessThan(25 + 20); // the models table is small; no other table grows with the team
  });

  test("Next draws rows 26 to 50", () => {
    const m = mount();
    const first = m.names();
    m.next();
    expect(m.range()).toBe("26–50 of 2,000");
    expect(m.names()).toHaveLength(25);
    expect(m.names()[0]).toBe(team().members[25]?.name);
    expect(m.names()).not.toContain(first[0]);
  });

  test("choosing 100 draws 100 rows and keeps the choice", () => {
    const m = mount();
    m.choose("100");
    expect(m.count()).toBe(100);
    expect(m.range()).toBe("1–100 of 2,000");
    expect(store.get("teamusage.rows")).toBe("100");
    expect(mount().count()).toBe(100);
  });

  test("the stored size is used when the table is drawn, and a stored size that is no size is not", () => {
    store.set("teamusage.rows", "50");
    expect(mount().count()).toBe(50);
    store.set("teamusage.rows", "7");
    expect(mount().count()).toBe(25);
  });

  test("a blocked storage still lets the size change for this visit", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const m = mount();
    expect(m.count()).toBe(25);
    m.choose("50");
    expect(m.count()).toBe(50);
  });

  test("the last page holds what is left", () => {
    const m = mount(team(60));
    m.next();
    m.next();
    expect(m.range()).toBe("51–60 of 60");
    expect(m.count()).toBe(10);
    expect((m.host.querySelector('.pager button[data-step="next"]') as HTMLButtonElement).disabled).toBe(true);
  });

  test("a team of 21 and a team of 1 read their own counts", () => {
    expect(mount(team(21)).range()).toBe("1–21 of 21");
    expect(mount(team(1)).range()).toBe("1–1 of 1");
  });

  test("a team with no members draws no pager and no rows", () => {
    const m = mount(team(0));
    expect(m.host.querySelector(".pager")).toBeNull();
    expect(m.count()).toBe(0);
  });

  test("the Russian footer reads 1–25 из 2 000", () => {
    expect(mount(team(), { lang: "ru" }).range()).toBe(`1–25 из 2${NBSP}000`);
  });
});

describe("search covers everyone", () => {
  test("a query only member 1,987 matches draws that one row on page 1", () => {
    const m = mount();
    m.next();
    m.next();
    m.search("1987.");
    expect(m.names()).toEqual([team().members[1986]?.name]);
    expect(m.range()).toBe("1–1 of 1");
    expect(m.count_line()).toBe("1 of 2,000 members");
  });

  test("a query matching many members pages them, from page 1", () => {
    const m = mount();
    m.next();
    m.next();
    m.search("jo ");
    expect(m.range()).toMatch(/^1–25 of /);
    expect(m.count()).toBe(25);
    expect(m.names().every((n) => n?.toLowerCase().includes("jo "))).toBe(true);
  });

  test("a query nobody matches draws no pager", () => {
    const m = mount();
    m.search("zzzz");
    expect(m.host.querySelector(".pager")).toBeNull();
    expect(m.count_line()).toBe("No members match");
  });

  test("new statistics show page 1", () => {
    const m = mount();
    m.next();
    m.next();
    m.search("", team());
    expect(m.range()).toBe("1–25 of 2,000");
  });
});

describe("sorting covers everyone", () => {
  test("every header that sorts is a button in its th; the others are not", () => {
    const m = mount();
    const buttons = [...m.host.querySelectorAll("#members thead th button")];
    expect(buttons.map((b) => [b.getAttribute("data-sort"), b.getAttribute("type")])).toEqual([["name", "button"], ["tokens", "button"], ["cost", "button"], ["lastSync", "button"]]);
    expect(m.host.querySelectorAll("#members thead th")).toHaveLength(6);
  });

  test("Total tokens starts as the sorted column, largest first", () => {
    const m = mount();
    expect(m.th("tokens").getAttribute("aria-sort")).toBe("descending");
    expect(m.th("tokens").querySelector(".sort")?.textContent).toBe("↓");
    expect(["name", "cost", "lastSync"].map((by) => m.th(by).hasAttribute("aria-sort"))).toEqual([false, false, false]);
  });

  test("pressing Cost sorts by cost, descending, and moves aria-sort off Total tokens", () => {
    const m = mount();
    m.sortBy("cost");
    expect(m.th("cost").getAttribute("aria-sort")).toBe("descending");
    expect(m.th("tokens").hasAttribute("aria-sort")).toBe(false);
    expect(m.th("tokens").querySelector(".sort")).toBeNull();
    const costs = team().members.map((x) => x.costUsd);
    expect(m.host.querySelectorAll("#members tbody tr")).toHaveLength(25);
    expect(m.host.querySelector("#members tbody tr td:nth-of-type(2)")?.textContent).toBe(`$${Math.max(...costs).toFixed(2)}`);
  });

  test("pressing the same column again turns it round", () => {
    const m = mount();
    m.sortBy("cost");
    m.sortBy("cost");
    expect(m.th("cost").getAttribute("aria-sort")).toBe("ascending");
    expect(m.th("cost").querySelector(".sort")?.textContent).toBe("↑");
    expect(m.host.querySelector("#members tbody tr td:nth-of-type(2)")?.textContent).toBe("$0.00");
  });

  test("Member sorts the names from A, over all 2,000 and not just the page", () => {
    const m = mount();
    m.sortBy("name");
    const all = team().members.map((x) => x.name).sort(new Intl.Collator("en").compare);
    expect(m.names()).toEqual(all.slice(0, 25));
  });

  test("a new sort shows page 1", () => {
    const m = mount();
    m.next();
    m.sortBy("name");
    expect(m.range()).toBe("1–25 of 2,000");
  });

  test("a new page size shows page 1", () => {
    const m = mount();
    m.next();
    m.next();
    m.choose("50");
    expect(m.range()).toBe("1–50 of 2,000");
  });

  test("the sort is kept by a caller that repaints: it is given back and reported", () => {
    const seen: MemberSort[] = [];
    const m = mount(team(), { onSort: (s) => seen.push(s) });
    m.sortBy("lastSync");
    expect(seen).toEqual([{ by: "lastSync", dir: "desc" }]);
    const again = mount(team(), { sort: seen[0] });
    expect(again.th("lastSync").getAttribute("aria-sort")).toBe("descending");
    expect(again.th("tokens").hasAttribute("aria-sort")).toBe(false);
  });

  test("sorting keeps the search: only the matching members are sorted", () => {
    const m = mount();
    m.host.querySelector<HTMLInputElement>("#member-search")!.value = "jo ";
    m.search("jo ");
    m.sortBy("name");
    expect(m.names().every((n) => n?.toLowerCase().includes("jo "))).toBe(true);
  });

  test("the bars scale to the team's largest member, whatever the page shows", () => {
    const m = mount();
    m.sortBy("tokens"); // ascending: the page holds the smallest members
    const bar = m.host.querySelector("#members tbody tr .mix-bar") as HTMLElement;
    expect(bar.style.width).toBe(`${Number(((10 / 20_000) * 100).toFixed(1))}%`);
  });

  test("a member who never synced is last on a sort by last sync, on the last page", () => {
    const m = mount(team(30));
    m.sortBy("lastSync");
    m.next();
    expect(m.host.querySelector("#members tbody tr:last-child td:nth-last-child(2)")?.textContent).toBe("—");
  });
});
