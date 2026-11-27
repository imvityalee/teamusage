import type { Stats } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import { renderStats } from "../render.js";
import { applyMemberSearch } from "./members-panel.js";
import { CODEX_ONLY, HOSTILE, TODAY, cells, codexOnly, newDocument, render, rows, tags, who } from "../render.fixture.js";
import { statsFixture } from "../test-fixtures.js";

describe("members table", () => {
  test("lists the members by tokens, each with an initials avatar, name, email, tokens, cost and last sync", () => {
    const r = rows(render(), "members");
    expect(r.map(who)).toEqual([
      ["AA", "Alice Archer", "alice@example.com"],
      ["BN", "Bao Nguyen", "bao@example.com"],
      ["CM", "Carla Mendes", "carla@example.com"],
    ]);
    expect(cells(r[0] as Element).slice(1)).toEqual(["40,000", "$9.00", "", "Team · Devcats · Premium 78%Unknown 13%+1", "today", ""]);
    expect(cells(r[1] as Element)[5]).toBe("8 days ago");
    expect(cells(r[2] as Element)[5]).toBe("—");
    expect(r.map((row) => row.querySelector(".avatar")?.getAttribute("aria-hidden"))).toEqual(["true", "true", "true"]);
  });

  test("a last sync 7 or more days ago is marked stale, in words and colour", () => {
    const r = rows(render(), "members");
    expect(r.map((row) => row.querySelectorAll("td")[4]?.classList.contains("stale"))).toEqual([false, true, false]);
  });

  test("the agent mix: length is the share of the top member, segments are agents in fixed colours", () => {
    const r = rows(render(), "members");
    const bars = r.map((row) => row.querySelector(".mix") as HTMLElement);
    expect(bars.map((b) => b.getAttribute("role"))).toEqual(["img", "img", "img"]);
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "66% of the team's tokens: Claude Code 88%, Codex 11%, aider 1%",
      "34% of the team's tokens: Claude Code 98%, Codex 2%",
      "0% of the team's tokens",
    ]);
    expect(bars.map((b) => (b.querySelector(".mix-bar") as HTMLElement).style.width)).toEqual(["100%", "51.2%", "0%"]);
    expect([...(bars[0] as Element).querySelectorAll(".mix-bar i")].map((i) => i.getAttribute("class"))).toEqual(["ag-claude", "ag-codex", "ag-other"]);
    expect(bars[2]?.querySelectorAll(".mix-bar i")).toHaveLength(0);
    const root = render();
    expect(root.querySelector("#members thead")?.textContent).toContain("Agent mix");
    expect(root.querySelector(".mix-note")?.textContent).toBe(
      "The bar's length compares each member with the most active member; its colours show which agents they used.",
    );
  });

  test("while a filter is active the bar's label speaks of the filtered tokens", () => {
    const label = (lang: "en" | "ru") => render(codexOnly(), lang, CODEX_ONLY).querySelector("#members .mix")?.getAttribute("aria-label");
    expect(label("en")).toBe("90% of the filtered tokens: Codex 100%");
    expect(label("ru")).toBe("90% отфильтрованных токенов: Codex 100%");
    expect(render(statsFixture(), "ru").querySelector("#members thead")?.textContent).toContain("Состав по агентам");
  });

  test("an agent keeps its colour in the mix whatever the order of the totals", () => {
    const stats = statsFixture();
    (stats.members[0] as Stats["members"][number] & { byAgent: unknown }).byAgent = { copilot: 1, gemini: 30_000, claude: 9_999 };
    const segs = [...render(stats).querySelectorAll("#members tbody tr:first-child .mix-bar i")].map((i) => i.getAttribute("class"));
    expect(segs).toEqual(["ag-claude", "ag-gemini", "ag-copilot"]);
  });

  test("headers are scoped; the sorted column says so; the row chevron is decorative", () => {
    const root = render();
    const ths = [...root.querySelectorAll("thead th")];
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) expect(th.getAttribute("scope")).toBe("col");
    for (const th of root.querySelectorAll("tbody th")) expect(th.getAttribute("scope")).toBe("row");
    const sorted = root.querySelector('#members th[aria-sort="descending"]');
    expect(sorted?.textContent).toBe("Total tokens↓");
    expect(sorted?.querySelector(".sort")?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector('#models th[aria-sort="descending"]')?.textContent).toBe("Total tokens↓");
    for (const c of root.querySelectorAll("#members .chev-cell")) expect(c.getAttribute("aria-hidden")).toBe("true");
  });

  test("the heading shows the count, a hint and the search placeholder", () => {
    const root = render();
    expect(root.querySelector("#members-heading")?.textContent).toBe("Members 3");
    expect(root.querySelector("#members-heading ~ .hint, .panel-head .hint")?.textContent).toBe("Select a member to see their own usage");
    expect((root.querySelector("#member-search") as HTMLInputElement).placeholder).toBe("Search by name or email");
  });
});

describe("members table: accounts", () => {
  const accountLines = (root: Element) =>
    rows(root, "members").map((row) => {
      const cell = row.querySelector("td.accts-cell") as Element;
      const lines = [...cell.querySelectorAll("li")].map((li) => li.textContent);
      return lines.length > 0 ? lines : cell.textContent;
    });

  test("an Accounts column after the agent mix: largest first as Name share%, at most two lines then +N; none is a dash", () => {
    const root = render();
    expect([...root.querySelectorAll("#members thead th")].map((th) => th.textContent)).toEqual([
      "Member",
      "Total tokens↓",
      "Cost (USD)",
      "Agent mix",
      "Accounts",
      "Last sync",
    ]);
    expect(accountLines(root)).toEqual([["Team · Devcats · Premium 78%", "Unknown 13%", "+1"], ["Team · Devcats · Premium 98%", "Unknown 2%"], "—"]);
    expect(render(statsFixture(), "ru").querySelectorAll("#members thead th")[4]?.textContent).toBe("Аккаунты");
    expect(accountLines(render(statsFixture(), "ru"))[0]).toEqual(["Команда · Devcats · Premium 78%", "Неизвестно 13%", "+1"]);
  });

  test("many accounts: two lines and the count of the rest; ties keep a fixed order", () => {
    const stats = statsFixture();
    (stats.members[0] as Stats["members"][number]).byAccountPlan = [{ account: "api", plan: "none", tokens: 10 }, { account: "personal", plan: "none", tokens: 10 }, { account: "team:", plan: "none", tokens: 30 }, { account: "enterprise:", plan: "claude:enterprise", tokens: 40 }, { account: "unknown", plan: "none", tokens: 10 }];
    expect(accountLines(render(stats))[0]).toEqual(["Enterprise 40%", "Team 30%", "+3"]);
  });

  test("text only: no colour, no bar, no style; malformed keys and numbers are left out", () => {
    const stats = statsFixture();
    (stats.members[0] as Stats["members"][number]).byAccountPlan = [{ account: "boss", plan: "none", tokens: 999 }, { account: "team:A", plan: "none", tokens: 3 }, { account: "personal", plan: "none", tokens: Number.NaN }, { account: "api", plan: "none", tokens: -1 }, { account: "unknown", plan: "none", tokens: 1 }, { account: "unknown", plan: "claude:gold", tokens: 50 }, { account: "unknown", plan: 7, tokens: 50 }, null, "x"] as unknown as Stats["members"][number]["byAccountPlan"];
    delete (stats.members[1] as { byAccountPlan?: unknown }).byAccountPlan;
    const root = render(stats);
    expect(accountLines(root)).toEqual([["Team · A 75%", "Unknown 25%"], "—", "—"]);
    for (const el of root.querySelectorAll("td.accts-cell, td.accts-cell *")) {
      expect(el.getAttribute("style")).toBeNull();
      expect(el.getAttribute("class") ?? "").not.toMatch(/ag-/);
    }
  });

  test("renders org as text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const withOrg = (org: string) => {
      const stats = statsFixture();
      (stats.members[0] as Stats["members"][number]).byAccountPlan = [{ account: `team:${org}`, plan: "none", tokens: 3 }, { account: `enterprise:${org}`, plan: "none", tokens: 1 }];
      return render(stats);
    };
    const root = withOrg(evil);
    expect(tags(root)).toEqual(tags(withOrg("Plain")));
    expect(root.querySelector("#members img, script")).toBeNull();
    expect(accountLines(root)[0]).toEqual([`Team · ${evil} 75%`, `Enterprise · ${evil} 25%`]);
  });
});

describe("members table: account and plan", () => {
  test("Codex accounts, Other agents, plan suffix; enterprise plans and no plan add none; same label merged", () => {
    const stats = statsFixture();
    (stats.members[0] as Stats["members"][number]).byAccountPlan = [
      { account: "chatgpt:personal", plan: "codex:plus", tokens: 50 },
      { account: "other", plan: "none", tokens: 30 },
      { account: "enterprise:Acme", plan: "claude:enterprise", tokens: 10 },
      { account: "enterprise:Acme", plan: "none", tokens: 10 },
    ];
    const lines = [...(rows(render(stats), "members")[0] as Element).querySelectorAll("td.accts-cell li")].map((li) => li.textContent);
    expect(lines).toEqual(["Personal · ChatGPT · Plus 50%", "Other agents 30%", "+1"]);
  });
});


describe("member links", () => {
  test("every member name links to their page by numeric id", () => {
    const links = [...render().querySelectorAll("#members tbody th a")].map((a) => [a.getAttribute("href"), a.textContent]);
    expect(links).toEqual([
      ["#/member/1", "Alice Archer"],
      ["#/member/2", "Bao Nguyen"],
      ["#/member/3", "Carla Mendes"],
    ]);
  });

  test("a hostile name never reaches the href", () => {
    expect(render(statsFixture(HOSTILE)).querySelector("#members tbody th a")?.getAttribute("href")).toBe("#/member/1");
  });

  test("an id that is not a plain positive integer gets no link and no markup", () => {
    const stats = statsFixture();
    const first = stats.members[0] as Stats["members"][number];
    first.id = `1"><img src=x onerror=alert(1)>` as unknown as number;
    (stats.members[1] as Stats["members"][number]).id = 0;
    const root = render(stats);
    expect(root.querySelectorAll("#members tbody th a")).toHaveLength(1);
    expect(root.querySelector("#members img")).toBeNull();
    expect(who(rows(root, "members")[0] as Element)).toEqual(["AA", "Alice Archer", "alice@example.com"]);
  });
});


describe("member search", () => {
  const renderQuery = (query: string, lang: "en" | "ru" = "en") => {
    const doc = newDocument();
    const host = doc.createElement("div");
    host.append(renderStats(doc, statsFixture(), lang, TODAY, { query }));
    return host;
  };
  const count = (root: Element) => root.querySelector<HTMLElement>("#members-count");

  test("a labelled search box sits in the members panel header", () => {
    const root = render();
    const input = root.querySelector<HTMLInputElement>(".panel-head input");
    expect(input?.type).toBe("search");
    expect(input?.id).toBe("member-search");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(root.querySelector('label[for="member-search"]')?.textContent).toBe("Search members");
    expect(render(statsFixture(), "ru").querySelector('label[for="member-search"]')?.textContent).toBe("Поиск участников");
    expect(count(root)?.hidden).toBe(true);
  });

  test("a query narrows the rows and says how many of how many", () => {
    const root = renderQuery("BAO");
    expect(rows(root, "members").map((r) => who(r)[1])).toEqual(["Bao Nguyen"]);
    expect(count(root)?.hidden).toBe(false);
    expect(count(root)?.textContent).toBe("1 of 3 members");
    expect(root.querySelector<HTMLInputElement>("#member-search")?.value).toBe("BAO");
    expect(renderQuery("example", "ru").querySelector("#members-count")?.textContent).toBe("3 из 3 участников");
  });

  test("no match says so and hides the table", () => {
    const root = renderQuery("<b>");
    expect(rows(root, "members")).toHaveLength(0);
    expect(count(root)?.textContent).toBe("No members match");
    expect((root.querySelector("#members")?.closest(".scroll") as HTMLElement).hidden).toBe(true);
    expect(root.querySelector("b")).toBeNull();
    expect(renderQuery("zzz", "ru").querySelector("#members-count")?.textContent).toBe("Участники не найдены");
  });

  test("applyMemberSearch updates the rows in place and keeps the input", () => {
    const doc = newDocument();
    const host = doc.createElement("div");
    const stats = statsFixture();
    host.append(renderStats(doc, stats, "en", TODAY));
    const input = host.querySelector("#member-search");
    applyMemberSearch(doc, host, stats, "en", TODAY, "carla");
    expect(rows(host, "members").map((r) => who(r)[1])).toEqual(["Carla Mendes"]);
    expect(host.querySelector("#member-search")).toBe(input);
    expect(count(host)?.textContent).toBe("1 of 3 members");
    applyMemberSearch(doc, host, stats, "en", TODAY, "  ");
    expect(rows(host, "members")).toHaveLength(3);
    expect(count(host)?.hidden).toBe(true);
    // Bars keep scaling to the top member of the whole team.
    applyMemberSearch(doc, host, stats, "en", TODAY, "bao");
    expect((host.querySelector("#members .mix-bar") as HTMLElement).style.width).toBe("51.2%");
  });
});

