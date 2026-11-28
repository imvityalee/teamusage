import { afterEach, describe, expect, test } from "vitest";
import { worstCase } from "../site/worst-case.fixture.js";
import { machine, member, team, TODAY } from "./members.fixture.js";
import { mountMembers, type MountedMembers } from "./members-card.fixture.js";

let m: MountedMembers;
afterEach(async () => m?.world.close());

const visibleEl = (sel: string) => {
  const el = m.$(sel);
  return el !== null && !el.hidden && el.closest("[hidden]") === null;
};
const rowsDrawn = () => m.all("tbody tr[data-member-id]").length;

describe("the list", () => {
  test("2,000 members: one page of 25 rows is drawn, with the heading, the line under the team's name and the range", async () => {
    m = await mountMembers(team(2000, 14));
    expect(m.world.calls.map((c) => c.url)).toEqual([`/api/teams/${m.world.ctx.team().id}/members`]);
    expect(rowsDrawn()).toBe(25);
    expect(m.all("tbody tr")).toHaveLength(25);
    expect(m.names()[0]).toBe("Person 0001");
    expect(m.$("#members-title").textContent).toBe("Members 2,000");
    expect(m.card.summary.textContent).toBe("2,000 members, 14 not syncing");
    expect(m.$(".pager-range").textContent).toBe("1–25 of 2,000");
  });

  test("a row has a tick box that names its member, the name and email, a machine, the sync, the day they joined and Remove", async () => {
    m = await mountMembers([member(7, [machine("2026-10-17", "daniyar-mbp")], { name: "Данияр Жумабеков", email: "daniyar@acme.example", joinedAt: "2026-09-02T12:00:00.000Z" })]);
    const row = m.$("tr[data-member-id='7']");
    expect(row.querySelector("input[data-tick]")?.getAttribute("aria-label")).toBe("Select Данияр Жумабеков");
    expect(row.querySelector(".member-name")?.textContent).toBe("Данияр Жумабеков");
    expect(row.querySelector(".member-email")?.textContent).toBe("daniyar@acme.example");
    expect(row.querySelector(".machines-cell")?.textContent).toBe("daniyar-mbp");
    expect(row.querySelector(".sync-cell .badge.warn")?.textContent).toBe("41 days ago");
    expect(row.querySelector(".joined")?.textContent).toBe("Sep 2, 2026");
    const remove = row.querySelector<HTMLElement>("[data-action='remove']");
    expect([remove?.textContent, remove?.getAttribute("aria-label")]).toEqual(["Remove", "Remove Данияр Жумабеков"]);
  });

  test.each([
    [TODAY, "today", false],
    ["2026-11-26", "yesterday", false],
    ["2026-11-24", "3 days ago", false],
    ["2026-11-20", "7 days ago", true],
    [null, "never", true],
  ])("a member who last synced on %s reads %s, and is marked not syncing: %s", async (day, text, stale) => {
    m = await mountMembers([member(1, [machine(day)])]);
    const cell = m.$(".sync-cell");
    expect(cell.textContent).toBe(text);
    expect(cell.querySelector(".badge.warn") !== null).toBe(stale);
  });

  test("a team with no members says so, and has no table, no search and no pager", async () => {
    m = await mountMembers([]);
    expect(m.$("#members-empty").textContent).toBe("Nobody has joined yet. Send the invite message above.");
    expect(visibleEl("#members-empty")).toBe(true);
    expect(m.all("table")).toHaveLength(0);
    expect(visibleEl("#member-search")).toBe(false);
    expect(m.all(".pager")).toHaveLength(0);
    expect(m.$("#members-title").textContent).toBe("Members 0");
    expect(m.card.summary.textContent).toBe("0 members, 0 not syncing");
  });

  test("one member reads Members 1 and 1 member, 0 not syncing", async () => {
    m = await mountMembers(team(1));
    expect(m.$("#members-title").textContent).toBe("Members 1");
    expect(m.card.summary.textContent).toBe("1 member, 0 not syncing");
  });

  test.each([
    [21, 1, "21 участник, 1 не синхронизируется"],
    [2, 2, "2 участника, 2 не синхронизируются"],
    [5, 5, "5 участников, 5 не синхронизируются"],
    [12, 0, "12 участников, 0 не синхронизируются"],
  ])("Russian: %i members, %i not syncing read %s", async (count, stale, text) => {
    m = await mountMembers(team(count, stale), [], { lang: "ru" });
    expect(m.card.summary.textContent).toBe(text);
  });

  test("Russian reads the thousands with the language's own separator, and its own days", async () => {
    m = await mountMembers(team(2000, 21), [], { lang: "ru" });
    expect(m.$("#members-title").textContent).toBe("Участники 2 000");
    expect(m.$(".sync-cell").textContent).toBe("41 день назад");
  });

  test("every value is drawn as text, whole: a 100-character name, a 254-character email, a long machine label, markup", async () => {
    type Person = (typeof worstCase.people)[number];
    const [long, short, , , fox] = worstCase.people as [Person, Person, Person, Person, Person];
    const evil = member(5, [machine(TODAY, "<img src=x onerror=alert(1)>")], { name: "<b>bold</b>", email: "<script>x</script>@acme.example" });
    m = await mountMembers([
      member(1, [machine(TODAY, worstCase.machineLabel)], { name: long.name, email: long.email }),
      member(2, [machine(TODAY)], { name: short.name, email: short.email }),
      member(3, [machine(TODAY)], { name: fox.name, email: fox.email }),
      evil,
    ]);
    expect(m.names()).toEqual(expect.arrayContaining([long.name, short.name, fox.name, "<b>bold</b>"]));
    expect(m.$("tr[data-member-id='1'] .member-email").textContent).toBe(long.email);
    expect(m.$("tr[data-member-id='1'] .machines-cell").textContent).toBe(worstCase.machineLabel);
    expect(m.$("tr[data-member-id='5'] .machines-cell").textContent).toBe("<img src=x onerror=alert(1)>");
    expect(m.all("tbody img, tbody b, tbody script")).toHaveLength(0);
  });

  test("a member with one machine shows its label; with none, says so", async () => {
    m = await mountMembers([member(1, [machine(TODAY, "solo")]), member(2, [])]);
    expect(m.all("[data-action='more']")).toHaveLength(0);
    expect(m.$("tr[data-member-id='2'] .machines-cell").textContent).toBe("No machines");
  });
});

describe("the machines of a member", () => {
  const three = () => [member(1, [machine(TODAY, "first-mbp"), machine("2026-11-01", "second"), machine(null, "third")], { name: "Maximilian" })];

  test("'and 2 more' opens three machines, each with its last sync and a Remove machine", async () => {
    m = await mountMembers(three());
    const more = m.$("[data-action='more']");
    expect(more.textContent).toBe("and 2 more");
    expect(m.$("tr[data-member-id='1'] .machines-cell").textContent).toBe("first-mbp and 2 more");
    const panel = m.$("#machines-1");
    expect([more.getAttribute("aria-expanded"), more.getAttribute("aria-controls"), panel.hidden]).toEqual(["false", "machines-1", true]);
    more.click();
    expect([more.getAttribute("aria-expanded"), panel.hidden]).toEqual(["true", false]);
    expect(panel.querySelector("ul")?.getAttribute("aria-label")).toBe("Machines of Maximilian");
    expect([...panel.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "first-mbpLast sync: todayRemove machine",
      "secondLast sync: 26 days agoRemove machine",
      "thirdLast sync: neverRemove machine",
    ]);
    expect(panel.querySelector("[data-action='remove-machine']")?.getAttribute("aria-label")).toBe("Remove machine first-mbp of Maximilian");
    more.click();
    expect([more.getAttribute("aria-expanded"), panel.hidden]).toEqual(["false", true]);
  });

  test("opening and closing keeps keyboard focus on the button", async () => {
    m = await mountMembers(three());
    const more = m.$("[data-action='more']");
    more.focus();
    more.click();
    expect(m.focused()).toBe(more);
    more.click();
    expect(m.focused()).toBe(more);
  });

  test("Russian counts the machines in three forms", async () => {
    const many = (n: number) => [member(1, Array.from({ length: n + 1 }, () => machine(TODAY)))];
    m = await mountMembers(many(1), [], { lang: "ru" });
    expect(m.$("[data-action='more']").textContent).toBe("и ещё 1 устройство");
    await m.world.close();
    m = await mountMembers(many(3), [], { lang: "ru" });
    expect(m.$("[data-action='more']").textContent).toBe("и ещё 3 устройства");
    await m.world.close();
    m = await mountMembers(many(5), [], { lang: "ru" });
    expect(m.$("[data-action='more']").textContent).toBe("и ещё 5 устройств");
  });
});

describe("the filter", () => {
  test("Not syncing shows only the people not syncing, its button holds the count of the whole team, and All brings everyone back", async () => {
    m = await mountMembers(team(60, 14));
    const [all, stale] = m.all("#members-filter button");
    expect([all?.textContent, stale?.textContent]).toEqual(["All", "Not syncing 14"]);
    expect([all?.getAttribute("aria-pressed"), stale?.getAttribute("aria-pressed")]).toEqual(["true", "false"]);
    stale?.click();
    expect(rowsDrawn()).toBe(14);
    expect(m.all("tbody tr[data-member-id]").every((r) => r.querySelector(".badge.warn") !== null)).toBe(true);
    expect([all?.getAttribute("aria-pressed"), stale?.getAttribute("aria-pressed")]).toEqual(["false", "true"]);
    expect(m.$(".pager-range").textContent).toBe("1–14 of 14");
    all?.click();
    expect(rowsDrawn()).toBe(25);
  });

  test("when nobody is not syncing, the filter says everyone is", async () => {
    m = await mountMembers(team(5));
    m.all("#members-filter button")[1]?.click();
    expect(m.$("#members-empty").textContent).toBe("Everyone is syncing.");
    expect(visibleEl("table")).toBe(false);
  });
});

describe("the search", () => {
  test("typing narrows the list to the matches of everyone, and the line under the name still counts the whole team", async () => {
    m = await mountMembers([...team(600, 14), member(900, [machine(TODAY)], { name: "Aigerim Toktosunova", email: "a.t@acme.example" })]);
    m.type("aigerim");
    expect(m.names()).toEqual(["Aigerim Toktosunova"]);
    expect(m.$(".pager-range").textContent).toBe("1–1 of 1");
    expect(m.card.summary.textContent).toBe("601 members, 14 not syncing");
    expect(m.$("#members-filter button:last-child").textContent).toBe("Not syncing 14");
  });

  test("a keystroke changes the rows and the range only: the box, the head, the pager and the bar are the same nodes", async () => {
    m = await mountMembers(team(2000));
    const kept = ["#member-search", "thead", "#members-tick-all", ".pager", ".pager-range", "#members-bar", "#members-filter", "table"].map((sel) => [sel, m.$(sel)] as const);
    m.type("Person 00");
    m.type("Person 001");
    for (const [sel, node] of kept) expect(m.$(sel), sel).toBe(node);
    expect(rowsDrawn()).toBeLessThanOrEqual(25);
  });

  test("a search that matches nobody says so, hides the table and the pager, and keeps the box", async () => {
    m = await mountMembers(team(40));
    m.type("zzz");
    expect(m.$("#members-empty").textContent).toBe("Nobody matches.");
    expect(visibleEl("table")).toBe(false);
    expect(m.all(".pager")).toHaveLength(0);
    expect(visibleEl("#member-search")).toBe(true);
    m.type("");
    expect(rowsDrawn()).toBe(25);
    expect(visibleEl("#members-empty")).toBe(false);
  });
});

describe("the order", () => {
  test("the list starts by name from A; the header says so", async () => {
    m = await mountMembers([member(1, [], { name: "Zoya" }), member(2, [], { name: "Anna" })]);
    expect(m.names()).toEqual(["Anna", "Zoya"]);
    expect(m.all("th[aria-sort]").map((th) => [th.textContent, th.getAttribute("aria-sort")])).toEqual([["Member↑", "ascending"]]);
  });

  test("pressing a header sorts by it, the largest or newest first, and pressing it again turns it round", async () => {
    m = await mountMembers([member(1, [machine(TODAY)], { name: "Zoya" }), member(2, [machine(TODAY), machine(TODAY)], { name: "Anna" }), member(3, [machine(TODAY), machine(TODAY), machine(TODAY)], { name: "Bo" })]);
    m.click("button[data-sort='machines']");
    expect(m.names()).toEqual(["Bo", "Anna", "Zoya"]);
    expect(m.$("th[aria-sort]").getAttribute("aria-sort")).toBe("descending");
    m.click("button[data-sort='machines']");
    expect(m.names()).toEqual(["Zoya", "Anna", "Bo"]);
    expect(m.all("th[aria-sort]")).toHaveLength(1);
    expect(m.$("th[aria-sort]").getAttribute("aria-sort")).toBe("ascending");
    m.click("button[data-sort='name']");
    expect(m.$("th[aria-sort] button").getAttribute("data-sort")).toBe("name");
    expect(m.names()).toEqual(["Anna", "Bo", "Zoya"]);
  });

  test("the pressed header keeps keyboard focus", async () => {
    m = await mountMembers(team(30));
    const button = m.$("button[data-sort='joined']");
    button.focus();
    button.click();
    expect(m.focused()).toBe(button);
    expect(m.$("button[data-sort='joined']")).toBe(button);
  });
});
