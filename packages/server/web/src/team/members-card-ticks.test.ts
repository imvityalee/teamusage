import { afterEach, describe, expect, test } from "vitest";
import type { MemberRow } from "./members.js";
import { machine, member, team, TODAY } from "./members.fixture.js";
import { membersReply, mountMembers, type MountedMembers } from "./members-card.fixture.js";

let m: MountedMembers;
afterEach(async () => m?.world.close());

const boxes = () => m.all<HTMLInputElement>("tbody input[data-tick]");
const headBox = () => m.$<HTMLInputElement>("#members-tick-all");
const bar = () => m.$("#members-bar");
const selected = () => m.$("#members-selected").textContent;
const ids = (rows: MemberRow[]) => rows.map((r) => r.id);

describe("the boxes and the bar", () => {
  test("no bar and an unticked header box while nothing is ticked", async () => {
    m = await mountMembers(team(30));
    expect([bar().hidden, headBox().checked, headBox().indeterminate]).toEqual([true, false, false]);
  });

  test("ticking a row shows the bar with '1 selected', and the header box is mixed", async () => {
    m = await mountMembers(team(30));
    boxes()[0]?.click();
    expect([bar().hidden, selected(), boxes()[0]?.checked]).toEqual([false, "1 selected", true]);
    expect([headBox().indeterminate, headBox().checked]).toEqual([true, false]);
    boxes()[0]?.click();
    expect([bar().hidden, headBox().indeterminate]).toEqual([true, false]);
  });

  test("the header's box and each row's box have a name", async () => {
    m = await mountMembers(team(3));
    expect(headBox().getAttribute("aria-label")).toBe("Select every member the search and the filter show");
    expect(boxes()[1]?.getAttribute("aria-label")).toBe("Select Person 0002");
  });

  test("the header's box ticks everyone the search leaves, on every page, and says '60 selected' while 25 are drawn", async () => {
    m = await mountMembers(team(60));
    headBox().click();
    expect([selected(), boxes().length, headBox().checked, headBox().indeterminate]).toEqual(["60 selected", 25, true, false]);
    expect(boxes().every((b) => b.checked)).toBe(true);
  });

  test("the header's box ticks only the matches of the search, keeps earlier ticks, and unticks only the matches", async () => {
    m = await mountMembers(team(60));
    boxes()[0]?.click();
    m.type("Person 005");
    headBox().click();
    expect(selected()).toBe("11 selected");
    headBox().click();
    expect(selected()).toBe("1 selected");
    m.type("");
    expect(boxes()[0]?.checked).toBe(true);
  });

  test("with a mixed box, pressing it ticks everyone", async () => {
    m = await mountMembers(team(40));
    boxes()[3]?.click();
    expect(headBox().indeterminate).toBe(true);
    headBox().click();
    expect([selected(), headBox().checked, headBox().indeterminate]).toEqual(["40 selected", true, false]);
  });

  test("with more than 500 members the first press ticks 500 (the box mixed, the bar says the most one removal takes), the second unticks them", async () => {
    m = await mountMembers(team(2000));
    headBox().click();
    expect(selected()).toBe("500 ticked, the most one removal takes.");
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect([headBox().checked, headBox().indeterminate]).toEqual([false, true]);
    for (let i = 0; i < 20; i++) m.click("button[data-step='next']");
    expect(m.all<HTMLInputElement>("tbody input[data-tick]").every((b) => b.disabled && !b.checked)).toBe(true);
    headBox().click();
    expect([bar().hidden, headBox().checked, headBox().indeterminate]).toEqual([true, false, false]);
  });

  test("500 ticked, then a search for someone who is not: the box is unticked, a press changes nothing, and the sentence about the cap stays", async () => {
    m = await mountMembers(team(2000));
    headBox().click();
    m.type("Person 1999");
    expect([headBox().checked, headBox().indeterminate]).toEqual([false, false]);
    headBox().click();
    expect(selected()).toBe("500 ticked, the most one removal takes.");
    expect(boxes()[0]?.checked).toBe(false);
  });

  test("ticks outside the search do not change the header's box", async () => {
    m = await mountMembers(team(60));
    boxes()[0]?.click();
    m.type("Person 0050");
    expect([headBox().checked, headBox().indeterminate]).toEqual([false, false]);
    expect(selected()).toBe("1 selected");
  });

  test("at exactly 500 members nothing is capped: '500 selected'", async () => {
    m = await mountMembers(team(500));
    headBox().click();
    expect(selected()).toBe("500 selected");
  });

  test("Russian: the bar counts in three forms", async () => {
    m = await mountMembers(team(30), [], { lang: "ru" });
    boxes()[0]?.click();
    expect(selected()).toBe("Выбран 1 участник");
    boxes()[1]?.click();
    expect(selected()).toBe("Выбрано 2 участника");
    for (const b of boxes().slice(2, 5)) b.click();
    expect(selected()).toBe("Выбрано 5 участников");
    expect(m.$("#members-clear").textContent).toBe("Сбросить");
    expect(m.$("#members-remove-selected").textContent).toBe("Удалить выбранных…");
  });
});

describe("the status node of the bar", () => {
  test("is the same node, in no hidden ancestor, before the first tick, after it and after Clear, and says what is ticked", async () => {
    m = await mountMembers(team(30));
    const live = m.$("#members-selected");
    const inHidden = () => live.closest("[hidden]") !== null;
    expect([inHidden(), live.textContent]).toEqual([false, ""]);
    boxes()[0]?.click();
    expect([m.$("#members-selected") === live, inHidden(), live.textContent]).toEqual([true, false, "1 selected"]);
    m.click("#members-clear");
    expect([m.$("#members-selected") === live, inHidden(), live.textContent]).toEqual([true, false, ""]);
  });
});

describe("the bar's own count is one node, updated in place", () => {
  test("it stays in the document and in its place through every change", async () => {
    m = await mountMembers(team(30));
    const live = m.$("#members-selected");
    expect(live.getAttribute("role")).toBe("status");
    boxes()[0]?.click();
    boxes()[1]?.click();
    headBox().click();
    m.click("#members-clear");
    expect(m.$("#members-selected")).toBe(live);
  });
});

describe("what keeps the ticks", () => {
  test("ticks survive paging, sorting, searching and filtering", async () => {
    m = await mountMembers(team(100, 10));
    boxes()[0]?.click();
    boxes()[1]?.click();
    m.click("button[data-step='next']");
    expect(selected()).toBe("2 selected");
    expect(boxes().every((b) => !b.checked)).toBe(true);
    m.click("button[data-step='prev']");
    expect([boxes()[0]?.checked, boxes()[1]?.checked, boxes()[2]?.checked]).toEqual([true, true, false]);
    m.click("button[data-sort='name']");
    m.click("button[data-sort='name']");
    expect(selected()).toBe("2 selected");
    m.type("Person 0001");
    m.type("");
    m.click("#members-filter button:last-child");
    expect(selected()).toBe("2 selected");
    m.click("#members-filter button:first-child");
    expect([boxes().find((b) => b.dataset.id === "1")?.checked, boxes().find((b) => b.dataset.id === "2")?.checked]).toEqual([true, true]);
  });

  test("a change of language keeps the ticks", async () => {
    m = await mountMembers(team(30));
    boxes()[0]?.click();
    m.world.setLang("ru");
    m.card.paint();
    expect([selected(), boxes()[0]?.checked, headBox().indeterminate]).toEqual(["Выбран 1 участник", true, true]);
  });

  test("a reload keeps the ticks of members who are still there", async () => {
    m = await mountMembers(team(30), [membersReply(team(30).slice(1, 20))]);
    boxes()[0]?.click();
    boxes()[1]?.click();
    await m.card.reload();
    await m.world.flush();
    expect(selected()).toBe("1 selected");
    expect(boxes().find((b) => b.dataset.id === "2")?.checked).toBe(true);
  });

  test("clearTicks takes every tick off", async () => {
    m = await mountMembers(team(30));
    headBox().click();
    m.card.clearTicks();
    expect([bar().hidden, boxes().some((b) => b.checked)]).toEqual([true, false]);
  });
});

describe("Clear", () => {
  test("takes every tick off, hides the bar and gives focus to the header's box", async () => {
    m = await mountMembers(team(60));
    headBox().click();
    m.$("#members-clear").focus();
    m.click("#members-clear");
    expect([bar().hidden, boxes().some((b) => b.checked), headBox().checked, headBox().indeterminate]).toEqual([true, false, false, false]);
    expect(m.focused()).toBe(headBox());
  });
});

describe("what the removal buttons send", () => {
  test("a row's Remove sends that member alone, and the button that was pressed", async () => {
    m = await mountMembers(team(30));
    const button = m.$("tr[data-member-id='3'] [data-action='remove']");
    button.click();
    expect(m.onRemove).toHaveBeenCalledTimes(1);
    const [what, opener] = m.onRemove.mock.calls[0] ?? [];
    expect(ids(what?.members ?? [])).toEqual([3]);
    expect(what?.machines).toEqual([]);
    expect(opener).toBe(button);
    expect(what?.members[0]?.name).toBe("Person 0003");
  });

  test("Remove selected sends the ticked rows of every page, not the page drawn", async () => {
    m = await mountMembers(team(100));
    boxes()[0]?.click();
    m.click("button[data-step='next']");
    m.click("button[data-step='next']");
    boxes()[2]?.click();
    m.click("#members-remove-selected");
    const [what, opener] = m.onRemove.mock.calls[0] ?? [];
    expect(ids(what?.members ?? [])).toEqual([1, 53]);
    expect(what?.machines).toEqual([]);
    expect(opener).toBe(m.$("#members-remove-selected"));
  });

  test("a machine's Remove machine sends that machine of that member, and no member", async () => {
    const mbp = machine(TODAY, "mbp");
    m = await mountMembers([member(8, [machine(TODAY, "air"), mbp, machine(null, "old")], { name: "Maximilian" })]);
    m.click("[data-action='more']");
    const button = m.$(`[data-action='remove-machine'][data-machine='${mbp.id}']`);
    button.click();
    const [what, opener] = m.onRemove.mock.calls[0] ?? [];
    expect(what?.members).toEqual([]);
    expect(what?.machines).toHaveLength(1);
    expect([what?.machines[0]?.member.id, what?.machines[0]?.machine]).toEqual([8, mbp]);
    expect(opener).toBe(button);
  });
});
