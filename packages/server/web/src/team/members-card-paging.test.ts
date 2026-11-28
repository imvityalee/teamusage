import { afterEach, describe, expect, test } from "vitest";
import { team } from "./members.fixture.js";
import { membersReply, mountMembers, type MountedMembers } from "./members-card.fixture.js";

let m: MountedMembers;
afterEach(async () => m?.world.close());

const rowsDrawn = () => m.all("tbody tr[data-member-id]").length;
const range = () => m.$(".pager-range").textContent;
const step = (which: "prev" | "next") => m.$<HTMLButtonElement>(`.pager button[data-step='${which}']`);
const chooseSize = (size: number) => {
  const select = m.$<HTMLSelectElement>(".pager select");
  select.value = String(size);
  select.dispatchEvent(new m.world.win.Event("change", { bubbles: true }) as unknown as Event);
};

describe("paging", () => {
  test("Next shows the next 25, Previous goes back, and the range is the same live node throughout", async () => {
    m = await mountMembers(team(2000));
    const live = m.$(".pager-range");
    expect(live.getAttribute("aria-live")).toBe("polite");
    step("next").click();
    expect([range(), m.names()[0], rowsDrawn()]).toEqual(["26–50 of 2,000", "Person 0026", 25]);
    step("prev").click();
    expect([range(), m.names()[0]]).toEqual(["1–25 of 2,000", "Person 0001"]);
    expect(m.$(".pager-range")).toBe(live);
  });

  test("a page never holds more rows than the size, with 2,000 members, at every size", async () => {
    m = await mountMembers(team(2000));
    for (const size of [50, 100, 25]) {
      chooseSize(size);
      expect(rowsDrawn()).toBe(size);
      expect(m.all("tbody tr")).toHaveLength(size);
    }
  });

  test("the last page holds what is left", async () => {
    m = await mountMembers(team(2000));
    chooseSize(100);
    for (let i = 0; i < 19; i++) step("next").click();
    expect([range(), rowsDrawn(), step("next").disabled]).toEqual(["1,901–2,000 of 2,000", 100, true]);
  });

  test("pressing Next on the last page hands focus to Previous, so that focus is not lost", async () => {
    m = await mountMembers(team(60));
    step("next").click();
    step("next").click();
    expect(step("next").disabled).toBe(true);
    expect(m.focused()).toBe(step("prev"));
  });

  test("everything on the smallest page: only the range shows", async () => {
    m = await mountMembers(team(20));
    expect(m.$(".pager-range").textContent).toBe("1–20 of 20");
    expect(m.$(".pager-size").hidden).toBe(true);
    expect(m.$(".pager-steps").hidden).toBe(true);
  });

  test("the page survives a repaint of the same data and a change of language", async () => {
    m = await mountMembers(team(100));
    step("next").click();
    m.card.paint();
    expect([range(), m.names()[0]]).toEqual(["26–50 of 100", "Person 0026"]);
    m.world.setLang("ru");
    m.card.paint();
    expect([range(), m.names()[0]]).toEqual(["26–50 из 100", "Person 0026"]);
    expect(step("prev").textContent).toBe("Назад");
  });

  test.each([
    ["a new search", () => m.type("Person 01")],
    ["a new filter", () => m.click("#members-filter button:last-child")],
    ["a new sort", () => m.click("button[data-sort='name']")],
    ["a new size", () => chooseSize(50)],
  ])("%s starts again from the first page", async (_name, act) => {
    m = await mountMembers(team(300, 80));
    step("next").click();
    step("next").click();
    expect(range()).toBe("51–75 of 300");
    act();
    expect(m.$(".pager-range").textContent).toMatch(/^1–/);
  });

  test("new data starts again from the first page", async () => {
    m = await mountMembers(team(300), [membersReply(team(300))]);
    step("next").click();
    await m.card.reload();
    await m.world.flush();
    expect(range()).toBe("1–25 of 300");
  });

  test("the size is remembered for the next visit", async () => {
    m = await mountMembers(team(300));
    chooseSize(100);
    expect(m.world.win.localStorage.getItem("teamusage.rows")).toBe("100");
  });
});
