import { describe, expect, test, vi } from "vitest";
import { mount, team } from "./members-panel.fixture.js";

/** The pager of the members table: where keyboard focus stays when a page changes, and the edges of one page and two. */

const focused = (m: ReturnType<typeof mount>) => {
  const el = m.doc.activeElement;
  return el?.tagName === "BUTTON" ? (el as HTMLElement).dataset.step : el?.tagName.toLowerCase();
};
const step = (m: ReturnType<typeof mount>, which: "prev" | "next") => m.host.querySelector<HTMLButtonElement>(`.pager button[data-step="${which}"]`)!;
/** Presses a pager button the way a person does: it takes focus, then the click arrives. */
const press = (m: ReturnType<typeof mount>, which: "prev" | "next") => {
  step(m, which).focus();
  step(m, which).click();
};

describe("focus stays where the person pressed", () => {
  test("after Next, on Next", () => {
    const m = mount(team(100));
    press(m, "next");
    expect(m.range()).toBe("26–50 of 100");
    expect(focused(m)).toBe("next");
  });

  test("Previous back to page 1 disables Previous, so focus goes to Next", () => {
    const m = mount(team(100));
    m.next();
    press(m, "prev");
    expect(m.range()).toBe("1–25 of 100");
    expect(step(m, "prev").disabled).toBe(true);
    expect(focused(m)).toBe("next");
  });

  test("on the last page the press of Next leaves focus on Previous", () => {
    const m = mount(team(50));
    press(m, "next");
    expect(step(m, "next").disabled).toBe(true);
    expect(focused(m)).toBe("prev");
  });

  test("Previous from page 3 keeps focus on Previous", () => {
    const m = mount(team(100));
    m.next();
    m.next();
    press(m, "prev");
    expect(m.range()).toBe("26–50 of 100");
    expect(focused(m)).toBe("prev");
  });

  test("after choosing a size, on the select", () => {
    const m = mount(team(200));
    m.host.querySelector<HTMLSelectElement>("select")!.focus();
    m.choose("50");
    expect(m.range()).toBe("1–50 of 200");
    expect(focused(m)).toBe("select");
  });

  test("nothing scrolls: no scroll call is made by a page change", () => {
    const m = mount(team(100));
    const scrolled = vi.fn();
    (m.host as unknown as { scrollIntoView: () => void }).scrollIntoView = scrolled;
    press(m, "next");
    expect(scrolled).not.toHaveBeenCalled();
  });

  test("a search or a sort does not pull focus to the pager", () => {
    const m = mount(team(100));
    m.sortBy("name");
    expect(m.doc.activeElement?.closest(".pager")).toBeNull();
  });
});

describe("the pager is updated in place, so its range is announced", () => {
  const rangeNode = (m: ReturnType<typeof mount>) => m.host.querySelector(".pager-range");

  test("the range element is the same node after Next, a size change, a search and a sort, and its text changed", () => {
    const m = mount(team(200));
    const node = rangeNode(m);
    const texts = [node?.textContent];
    const steps: [string, () => void][] = [
      ["Next", () => m.next()],
      ["a size change", () => m.choose("50")],
      ["a search", () => m.search("jo ")],
      ["a sort", () => m.sortBy("name")],
    ];
    for (const [name, act] of steps) {
      act();
      expect(rangeNode(m), name).toBe(node);
      texts.push(node?.textContent);
    }
    expect(new Set(texts).size).toBeGreaterThan(3);
  });

  test("the pressed Next is the same node and keeps focus", () => {
    const m = mount(team(100));
    const next = step(m, "next");
    press(m, "next");
    expect(step(m, "next")).toBe(next);
    expect(m.doc.activeElement).toBe(next);
  });

  test("the pager stays in the document through a search that matches nobody", () => {
    const m = mount(team(100));
    const pager = m.host.querySelector(".pager");
    m.search("zzzz");
    expect(m.host.querySelector(".pager")).toBeNull();
    m.search("");
    expect(m.host.querySelector(".pager")).toBe(pager);
  });

  test("a search down to under 26 members hides the select and buttons, and clearing it to 100 shows them again", () => {
    const m = mount(team(100));
    const hidden = () => [m.host.querySelector<HTMLElement>(".pager-size")?.hidden, m.host.querySelector<HTMLElement>(".pager-steps")?.hidden];
    m.search("jo 7", team(100));
    expect(m.count()).toBeGreaterThan(0);
    expect(m.count()).toBeLessThan(26);
    expect(hidden()).toEqual([true, true]);
    m.search("", team(100));
    expect(hidden()).toEqual([false, false]);
    expect(m.range()).toBe("1–25 of 100");
  });
});

describe("one page and two", () => {
  test("25 members fit on one page: only the range", () => {
    const m = mount(team(25));
    expect(m.range()).toBe("1–25 of 25");
    expect(m.host.querySelector<HTMLElement>(".pager-steps")?.hidden).toBe(true);
  });

  test("26 members need a second page: Next is on, and page 2 reads 26–26 of 26", () => {
    const m = mount(team(26));
    expect(step(m, "next").disabled).toBe(false);
    m.next();
    expect(m.range()).toBe("26–26 of 26");
    expect(m.count()).toBe(1);
  });
});
