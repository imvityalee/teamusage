import type { Stats } from "@teamusage/shared";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LOGO_PATHS } from "./agents.js";
import { renderChips, renderFilterControls, type FilterBarHandlers, type FilterBarModel } from "./filterbar.js";
import { NO_FILTERS, type Filters } from "./filters.js";
import { HOSTILE_IDS, statsFixture } from "./test-fixtures.js";

let doc: Document;
let calls: string[];
const handlers: FilterBarHandlers = {
  toggleOpen: (kind) => calls.push(`open:${kind}`),
  toggleAgent: (id) => calls.push(`agent:${id}`),
  toggleModel: (ref) => calls.push(`model:${ref.agent}|${ref.model}`),
  showAll: (kind) => calls.push(`all:${kind}`),
  modelQuery: (q) => calls.push(`query:${q}`),
  clear: () => calls.push("clear"),
};

beforeEach(() => {
  doc = new Window().document as unknown as Document;
  calls = [];
  // Nothing in the filter bar may talk to the network.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no request expected"))));
});
afterEach(() => vi.unstubAllGlobals());

const model = (over: Partial<FilterBarModel> = {}): FilterBarModel => ({
  available: statsFixture().available,
  filters: NO_FILTERS,
  open: null,
  modelQuery: "",
  note: null,
  ...over,
});

function controls(m: FilterBarModel, lang: "en" | "ru" = "en"): HTMLElement {
  const host = doc.createElement("div");
  doc.body.append(host);
  host.append(renderFilterControls(doc, m, lang, handlers));
  return host;
}

const tags = (root: Element) => [...root.querySelectorAll("*")].map((e) => e.tagName.toLowerCase());
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
const rowsOf = (root: Element) => [...root.querySelectorAll(".popover label.pop-row")].filter((r) => !(r.closest("li") as HTMLElement | null)?.hidden);
const change = (el: Element) => el.dispatchEvent(new (doc.defaultView as unknown as Window).Event("change", { bubbles: true }) as unknown as Event);
const input = (el: HTMLInputElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new (doc.defaultView as unknown as Window).Event("input", { bubbles: true }) as unknown as Event);
};

describe("filter buttons", () => {
  test("closed: two real buttons that announce a popup, reading All agents and All models", () => {
    const root = controls(model());
    const buttons = [...root.querySelectorAll("button.pill")];
    expect(buttons.map((b) => [b.id, text(b), b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded")])).toEqual([
      ["agents-btn", "All agents", "dialog", "false"],
      ["models-btn", "All models", "dialog", "false"],
    ]);
    expect(root.querySelector(".popover")).toBeNull();
    expect(root.querySelector("#clear-filters")).toBeNull();
    expect(buttons.every((b) => b.querySelector(".chev")?.classList.contains("up") === false)).toBe(true);
  });

  test("with a selection: counts with plural forms, the selected style and Clear filters", () => {
    const filters: Filters = { agents: ["claude", "codex"], models: [{ agent: "claude", model: "claude-opus-4-1" }] };
    const root = controls(model({ filters }));
    expect(text(root.querySelector("#agents-btn"))).toBe("2 agents");
    expect(text(root.querySelector("#models-btn"))).toBe("1 model");
    expect(root.querySelector("#agents-btn")?.classList.contains("selected")).toBe(true);
    expect(text(root.querySelector("#clear-filters"))).toBe("Clear filters");
    expect(root.querySelector("#clear-filters")?.tagName).toBe("BUTTON");
    const ru = controls(model({ filters }), "ru");
    expect(text(ru.querySelector("#agents-btn"))).toBe("2 агента");
    expect(text(ru.querySelector("#models-btn"))).toBe("1 модель");
    expect(text(ru.querySelector("#clear-filters"))).toBe("Сбросить фильтры");
  });

  test("clicking a button asks to open its popover; Clear filters clears", () => {
    const filters: Filters = { agents: ["codex"], models: [] };
    const root = controls(model({ filters }));
    (root.querySelector("#models-btn") as HTMLButtonElement).click();
    (root.querySelector("#clear-filters") as HTMLButtonElement).click();
    expect(calls).toEqual(["open:models", "clear"]);
  });
});

describe("agents popover", () => {
  test("lists available agents with icon, name and total, reflecting the selection", () => {
    const root = controls(model({ open: "agents", filters: { agents: ["codex"], models: [] } }));
    const btn = root.querySelector("#agents-btn") as HTMLElement;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.querySelector(".chev")?.classList.contains("up")).toBe(true);
    const pop = root.querySelector(".popover") as HTMLElement;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(btn.getAttribute("aria-controls")).toBe(pop.id);
    expect(doc.getElementById(pop.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Agents in this period");
    expect(text(pop.querySelector(".pop-head button"))).toBe("Show all");
    const rows = rowsOf(root);
    expect(rows.map((r) => [text(r.querySelector(".pop-name")), text(r.querySelector(".pop-num")), (r.querySelector("input") as HTMLInputElement).checked])).toEqual([
      ["Claude Code", "55,000", false],
      ["Codex", "5,000", true],
      ["aider", "500", false],
    ]);
    expect(rows.map((r) => r.classList.contains("checked"))).toEqual([false, true, false]);
    expect(rows.map((r) => r.querySelector(".agent-icon")?.className)).toEqual(["agent-icon ag-claude", "agent-icon ag-codex", "agent-icon ag-other"]);
    for (const box of pop.querySelectorAll("input")) expect(box.getAttribute("type")).toBe("checkbox");
    // The popover follows its button, so Tab moves from the button through the checkboxes.
    expect(btn.nextElementSibling).toBe(pop);
  });

  test("ticking a box and Show all report the agent id as given", () => {
    const root = controls(model({ open: "agents" }));
    change(rowsOf(root)[1]?.querySelector("input") as Element);
    (root.querySelector(".pop-head button") as HTMLButtonElement).click();
    expect(calls).toEqual(["agent:codex", "all:agents"]);
  });

  test("the limit note is shown inside the popover", () => {
    const root = controls(model({ open: "agents", note: { key: "agentLimit", vars: { n: 20 } } }));
    expect(text(root.querySelector(".popover .pop-note"))).toBe("You can select up to 20 agents.");
  });
});

describe("models popover", () => {
  test("has a labelled search field and groups models under agent headings", () => {
    const root = controls(model({ open: "models" }));
    const search = root.querySelector<HTMLInputElement>("#model-search") as HTMLInputElement;
    expect(search.type).toBe("search");
    expect(search.getAttribute("autocomplete")).toBe("off");
    expect(search.placeholder).toBe("Search models");
    expect(text(root.querySelector('label[for="model-search"]'))).toBe("Search models");
    expect(text(root.querySelector(".popover .pop-title"))).toBe("Models in this period");
    const groups = [...root.querySelectorAll(".pop-group")].map((g) => [text(g.querySelector(".pop-group-name")), [...g.querySelectorAll(".pop-name")].map((n) => n.textContent)]);
    expect(groups).toEqual([
      ["Claude Code", ["claude-sonnet-4-5", "claude-opus-4-1"]],
      ["Codex", ["gpt-5-codex"]],
      ["aider", ["some-model"]],
    ]);
    expect(rowsOf(root).map((r) => text(r.querySelector(".pop-num")))).toEqual(["30,000", "25,000", "5,000", "500"]);
    expect(root.querySelector(".pop-group .agent-logo")?.getAttribute("src")).toBe("/agents/claudecode.svg");
    expect(root.querySelector(".popover .pop-note")).toBeNull();
  });

  test("with an agent filter only those agents' models are listed, and it says so", () => {
    const root = controls(model({ open: "models", filters: { agents: ["codex"], models: [] } }));
    expect([...root.querySelectorAll(".pop-group-name")].map(text)).toEqual(["Codex"]);
    expect(text(root.querySelector(".popover .pop-hint"))).toBe("Only models of the selected agents are listed.");
  });

  test("ticking a model reports the exact pair; a selected model is checked", () => {
    const root = controls(model({ open: "models", filters: { agents: [], models: [{ agent: "claude", model: "claude-opus-4-1" }] } }));
    const rows = rowsOf(root);
    expect(rows.map((r) => (r.querySelector("input") as HTMLInputElement).checked)).toEqual([false, true, false, false]);
    change(rows[2]?.querySelector("input") as Element);
    expect(calls).toEqual(["model:codex|gpt-5-codex"]);
  });

  test("search narrows the list in place, without a request, as a plain substring", () => {
    const root = controls(model({ open: "models" }));
    const search = root.querySelector<HTMLInputElement>("#model-search") as HTMLInputElement;
    input(search, "OPUS");
    expect(calls).toEqual(["query:OPUS"]);
    expect(root.querySelector("#model-search")).toBe(search);
    expect(rowsOf(root).map((r) => r.querySelector(".pop-name")?.textContent)).toEqual(["claude-opus-4-1"]);
    expect([...root.querySelectorAll(".pop-group")].filter((g) => !(g as HTMLElement).hidden).map((g) => text(g.querySelector(".pop-group-name")))).toEqual(["Claude Code"]);
    for (const q of [".*", "(", "[", "\\", "<b>x</b>"]) {
      input(search, q);
      expect(rowsOf(root)).toHaveLength(0);
      expect(text(root.querySelector(".pop-empty"))).toBe("No models match");
    }
    expect(root.querySelector(".popover b")).toBeNull();
    input(search, "");
    expect(rowsOf(root)).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a query from state is applied when the popover is drawn", () => {
    const root = controls(model({ open: "models", modelQuery: "gpt" }));
    expect((root.querySelector("#model-search") as HTMLInputElement).value).toBe("gpt");
    expect(rowsOf(root).map((r) => r.querySelector(".pop-name")?.textContent)).toEqual(["gpt-5-codex"]);
  });
});

describe("hostile agent ids and model names", () => {
  const hostileAvailable = (): Stats["available"] => ({
    agents: ["claude", ...HOSTILE_IDS],
    models: [
      { agent: "claude", model: "<img src=x onerror=alert(1)>", tokens: 10 },
      ...HOSTILE_IDS.map((id, i) => ({ agent: id, model: `m${i}"><script>alert(1)</script>`, tokens: 5 })),
    ],
    accounts: [],
  });
  const plainAvailable = (): Stats["available"] => ({
    agents: ["claude", ...HOSTILE_IDS.map((_, i) => `plain${i}`)],
    models: [
      { agent: "claude", model: "plain-model", tokens: 10 },
      ...HOSTILE_IDS.map((_, i) => ({ agent: `plain${i}`, model: `m${i}`, tokens: 5 })),
    ],
    accounts: [],
  });

  test("create exactly the elements plain ids do, show literal text and load only fixed images", () => {
    for (const open of ["agents", "models"] as const) {
      const hostile = controls(model({ open, available: hostileAvailable(), filters: { agents: HOSTILE_IDS.slice(0, 3), models: [] } }));
      const plain = controls(model({ open, available: plainAvailable(), filters: { agents: ["plain0", "plain1", "plain2"], models: [] } }));
      expect(tags(hostile)).toEqual(tags(plain));
      for (const tag of ["script", "iframe"]) expect(hostile.querySelector(tag)).toBeNull();
      for (const img of hostile.querySelectorAll("img")) expect(LOGO_PATHS.has(img.getAttribute("src") ?? "")).toBe(true);
      for (const el of hostile.querySelectorAll("*")) {
        for (const attr of el.getAttributeNames()) {
          expect(attr.startsWith("on")).toBe(false);
          expect(el.getAttribute(attr) ?? "").not.toContain("<");
        }
        expect(el.getAttribute("style") ?? "").toBe("");
      }
    }
    const agents = controls(model({ open: "agents", available: hostileAvailable() }));
    expect(rowsOf(agents).map((r) => r.querySelector(".pop-name")?.textContent)).toEqual(["Claude Code", ...HOSTILE_IDS]);
    expect([...agents.querySelectorAll(".pop-row .agent-icon")].slice(1).map((i) => i.className)).toEqual(HOSTILE_IDS.map(() => "agent-icon ag-other"));
    change(rowsOf(agents)[4]?.querySelector("input") as Element);
    expect(calls.at(-1)).toBe(`agent:${HOSTILE_IDS[3]}`);
  });
});

describe("chips", () => {
  const chips = (filters: Filters, lang: "en" | "ru" = "en") => {
    const host = doc.createElement("div");
    host.append(...renderChips(doc, filters, lang, handlers));
    return host;
  };

  test("none without a filter", () => {
    expect(chips(NO_FILTERS).childNodes).toHaveLength(0);
  });

  test("Showing only, then one removable chip per selection", () => {
    const root = chips({ agents: ["claude", "codex"], models: [{ agent: "claude", model: "opus-4-7" }] });
    expect(text(root.querySelector(".chips-label"))).toBe("Showing only");
    const buttons = [...root.querySelectorAll("button.chip")];
    expect(buttons.map((b) => [text(b), b.getAttribute("aria-label")])).toEqual([
      ["Claude Code", "Remove filter: Claude Code"],
      ["Codex", "Remove filter: Codex"],
      ["opus-4-7", "Remove filter: opus-4-7 (Claude Code)"],
    ]);
    expect(buttons[0]?.querySelector("img")?.getAttribute("src")).toBe("/agents/claudecode.svg");
    expect(buttons[1]?.querySelector("img")).toBeNull();
    (buttons[1] as HTMLButtonElement).click();
    (buttons[2] as HTMLButtonElement).click();
    expect(calls).toEqual(["agent:codex", "model:claude|opus-4-7"]);
    expect(text(chips({ agents: ["codex"], models: [] }, "ru").querySelector(".chips-label"))).toBe("Показаны только");
  });

  test("hostile ids are literal text in chips and their labels", () => {
    const root = chips({ agents: HOSTILE_IDS, models: [{ agent: HOSTILE_IDS[3] as string, model: "<b>m</b>" }] });
    expect([...root.querySelectorAll("button.chip")].map((b) => text(b))).toEqual([...HOSTILE_IDS.map((id) => id.replace(/\s+/g, " ").trim()), "<b>m</b>"]);
    expect(root.querySelector("img, b, script")).toBeNull();
  });
});

describe("edge cases", () => {
  test("a model of an agent whose id has a colon is listed but cannot be ticked", () => {
    const available: Stats["available"] = { agents: ["x:a"], models: [{ agent: "x:a", model: "b", tokens: 3 }], accounts: [] };
    const root = controls(model({ open: "models", available }));
    const box = rowsOf(root)[0]?.querySelector("input") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(text(root.querySelector(".pop-name"))).toBe("b");
  });

  test("Russian plural forms on the buttons, including 11 and 21", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
    const available = (n: number): Stats["available"] => ({
      agents: many(n + 1),
      models: many(n + 1).map((a) => ({ agent: a, model: "m", tokens: 1 })),
      accounts: [],
    });
    const label = (n: number) =>
      text(
        controls(
          model({ available: available(n), filters: { agents: many(Math.min(n, 20)), models: many(n).map((a) => ({ agent: a, model: "m" })) } }),
          "ru",
        ).querySelector("#models-btn"),
      );
    expect([1, 3, 5, 11, 21].map(label)).toEqual(["1 модель", "3 модели", "5 моделей", "11 моделей", "21 модель"]);
  });

  test("nothing in the period: the popovers say so instead of an empty box", () => {
    const empty: Stats["available"] = { agents: [], models: [], accounts: [] };
    expect(text(controls(model({ open: "agents", available: empty })).querySelector(".pop-empty"))).toBe("Nothing in this period");
    const models = controls(model({ open: "models", available: empty }));
    expect(text(models.querySelector(".pop-empty"))).toBe("Nothing in this period");
  });

  test("every available agent ticked still reads as a count, not All", () => {
    const root = controls(model({ filters: { agents: ["claude", "codex", "aider"], models: [] } }));
    expect(text(root.querySelector("#agents-btn"))).toBe("3 agents");
  });

  test("a selection this member does not have stays listed, ticked, with a zero total, so it can be unticked", () => {
    const memberAvailable: Stats["available"] = { agents: ["claude"], models: [{ agent: "claude", model: "claude-opus-4-1", tokens: 7 }], accounts: [] };
    const filters: Filters = { agents: ["claude", "codex"], models: [{ agent: "codex", model: "gpt-5-codex" }] };
    const agents = controls(model({ open: "agents", available: memberAvailable, filters }));
    expect(rowsOf(agents).map((r) => [text(r.querySelector(".pop-name")), text(r.querySelector(".pop-num")), (r.querySelector("input") as HTMLInputElement).checked])).toEqual([
      ["Claude Code", "7", true],
      ["Codex", "0", true],
    ]);
    change(rowsOf(agents)[1]?.querySelector("input") as Element);
    expect(calls.at(-1)).toBe("agent:codex");
    const models = controls(model({ open: "models", available: memberAvailable, filters }));
    expect([...models.querySelectorAll(".pop-group")].map((g) => [text(g.querySelector(".pop-group-name")), [...g.querySelectorAll(".pop-row")].map((r) => [text(r.querySelector(".pop-name")), text(r.querySelector(".pop-num")), (r.querySelector("input") as HTMLInputElement).checked])])).toEqual([
      ["Claude Code", [["claude-opus-4-1", "7", false]]],
      ["Codex", [["gpt-5-codex", "0", true]]],
    ]);
  });

  test("malformed entries never show NaN or throw", () => {
    const bad = {
      agents: [null, "claude"],
      models: [null, { agent: "claude", model: "m", tokens: "x" }, { agent: "claude", model: "n", tokens: Number.NaN }],
    } as unknown as Stats["available"];
    for (const open of ["agents", "models"] as const) {
      const root = controls(model({ open, available: bad }));
      expect(root.textContent).not.toContain("NaN");
    }
  });

  test("only the open popover is in the page", () => {
    expect(controls(model({ open: "models" })).querySelectorAll(".popover")).toHaveLength(1);
    expect(controls(model({ open: "models" })).querySelector("#agents-btn")?.getAttribute("aria-expanded")).toBe("false");
  });
});
