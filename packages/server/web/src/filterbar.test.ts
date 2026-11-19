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
  toggleAccount: (key) => calls.push(`account:${key}`),
  togglePlan: (key) => calls.push(`plan:${key}`),
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
  test("closed: four real buttons that announce a popup, reading All agents, All models, All accounts and All plans", () => {
    const root = controls(model());
    const buttons = [...root.querySelectorAll("button.pill")];
    expect(buttons.map((b) => [b.id, text(b), b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded")])).toEqual([
      ["agents-btn", "All agents", "dialog", "false"],
      ["models-btn", "All models", "dialog", "false"],
      ["accounts-btn", "All accounts", "dialog", "false"],
      ["plans-btn", "All plans", "dialog", "false"],
    ]);
    expect(text(controls(model(), "ru").querySelector("#accounts-btn"))).toBe("Все аккаунты");
    expect(root.querySelector(".popover")).toBeNull();
    expect(root.querySelector("#clear-filters")).toBeNull();
    expect(buttons.every((b) => b.querySelector(".chev")?.classList.contains("up") === false)).toBe(true);
  });

  test("with a selection: counts with plural forms, the selected style and Clear filters", () => {
    const filters: Filters = { agents: ["claude", "codex"], models: [{ agent: "claude", model: "claude-opus-4-1" }], accounts: [], plans: [] };
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

  test("an account selection: counts with plural forms, the selected style and Clear filters on its own", () => {
    const label = (n: number, lang: "en" | "ru") => {
      const accounts = Array.from({ length: n }, (_, i) => `team:o${i}`);
      return text(controls(model({ filters: { agents: [], models: [], accounts, plans: [] } }), lang).querySelector("#accounts-btn"));
    };
    expect([1, 2, 5].map((n) => label(n, "en"))).toEqual(["1 account", "2 accounts", "5 accounts"]);
    expect([1, 3, 5, 11, 21].map((n) => label(n, "ru"))).toEqual(["1 аккаунт", "3 аккаунта", "5 аккаунтов", "11 аккаунтов", "21 аккаунт"]);
    const root = controls(model({ filters: { agents: [], models: [], accounts: ["personal"], plans: [] } }));
    expect(root.querySelector("#accounts-btn")?.classList.contains("selected")).toBe(true);
    expect(root.querySelector("#agents-btn")?.classList.contains("selected")).toBe(false);
    expect(text(root.querySelector("#clear-filters"))).toBe("Clear filters");
    (root.querySelector("#accounts-btn") as HTMLButtonElement).click();
    (root.querySelector("#clear-filters") as HTMLButtonElement).click();
    expect(calls).toEqual(["open:accounts", "clear"]);
  });

  test("clicking a button asks to open its popover; Clear filters clears", () => {
    const filters: Filters = { agents: ["codex"], models: [], accounts: [], plans: [] };
    const root = controls(model({ filters }));
    (root.querySelector("#models-btn") as HTMLButtonElement).click();
    (root.querySelector("#clear-filters") as HTMLButtonElement).click();
    expect(calls).toEqual(["open:models", "clear"]);
  });
});

describe("agents popover", () => {
  test("lists available agents with icon, name and total, reflecting the selection", () => {
    const root = controls(model({ open: "agents", filters: { agents: ["codex"], models: [], accounts: [], plans: [] } }));
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

describe("accounts popover", () => {
  test("lists available accounts by name with their compact total, reflecting the selection, text only", () => {
    const root = controls(model({ open: "accounts", filters: { agents: [], models: [], accounts: ["unknown"], plans: [] } }));
    const btn = root.querySelector("#accounts-btn") as HTMLElement;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const pop = root.querySelector(".popover") as HTMLElement;
    expect(pop.id).toBe("accounts-pop");
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(btn.getAttribute("aria-controls")).toBe(pop.id);
    expect(doc.getElementById(pop.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Accounts in this period");
    expect(text(pop.querySelector(".pop-head button"))).toBe("Show all");
    const rows = rowsOf(root);
    expect(rows.map((r) => [text(r.querySelector(".pop-name")), text(r.querySelector(".pop-num")), (r.querySelector("input") as HTMLInputElement).checked])).toEqual([
      ["Team · Devcats", "51,000", false],
      ["Unknown", "5,500", true],
      ["Personal", "4,000", false],
    ]);
    // No icon, no colour: accounts are text only.
    expect(pop.querySelector(".agent-icon, img, svg.icon")).toBeNull();
    expect(btn.nextElementSibling).toBe(pop);
    const ru = controls(model({ open: "accounts" }), "ru");
    expect(text(ru.querySelector(".popover .pop-title"))).toBe("Аккаунты за этот период");
    expect(rowsOf(ru).map((r) => text(r.querySelector(".pop-name")))).toEqual(["Команда · Devcats", "Неизвестно", "Личный"]);
  });

  test("ticking a box and Show all report the account key as given", () => {
    const root = controls(model({ open: "accounts" }));
    change(rowsOf(root)[0]?.querySelector("input") as Element);
    (root.querySelector(".pop-head button") as HTMLButtonElement).click();
    expect(calls).toEqual(["account:team:Devcats", "all:accounts"]);
  });

  test("the limit note and nothing in the period", () => {
    const root = controls(model({ open: "accounts", note: { key: "accountLimit", vars: { n: 50 } } }));
    expect(text(root.querySelector(".popover .pop-note"))).toBe("You can select up to 50 accounts.");
    const empty = controls(model({ open: "accounts", available: { agents: [], models: [], accounts: [], plans: [] } }));
    expect(text(empty.querySelector(".pop-empty"))).toBe("Nothing in this period");
  });

  test("a selected account this period or member lacks stays listed, ticked, at zero, so it can be unticked", () => {
    const memberAvailable: Stats["available"] = { ...statsFixture().available, accounts: [{ key: "personal", tokens: 7 }], plans: [] };
    const root = controls(model({ open: "accounts", available: memberAvailable, filters: { agents: [], models: [], accounts: ["team:Devcats"], plans: [] } }));
    expect(rowsOf(root).map((r) => [text(r.querySelector(".pop-name")), text(r.querySelector(".pop-num")), (r.querySelector("input") as HTMLInputElement).checked])).toEqual([
      ["Personal", "7", false],
      ["Team · Devcats", "0", true],
    ]);
    change(rowsOf(root)[1]?.querySelector("input") as Element);
    expect(calls).toEqual(["account:team:Devcats"]);
  });

  test("renders org as text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const available = (org: string): Stats["available"] => ({ ...statsFixture().available, accounts: [{ key: `team:${org}`, tokens: 9 }, { key: `enterprise:${org}`, tokens: 3 }], plans: [] });
    const filters: Filters = { agents: [], models: [], accounts: [`team:${evil}`], plans: [] };
    const hostile = controls(model({ open: "accounts", available: available(evil), filters }));
    const plain = controls(model({ open: "accounts", available: available("Plain"), filters: { ...filters, accounts: ["team:Plain"], plans: [] } }));
    expect(tags(hostile)).toEqual(tags(plain));
    expect(hostile.querySelector("img, script")).toBeNull();
    expect(rowsOf(hostile).map((r) => r.querySelector(".pop-name")?.textContent)).toEqual([`Team · ${evil}`, `Enterprise · ${evil}`]);
    for (const el of hostile.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith("on")).toBe(false);
        expect(el.getAttribute(attr) ?? "").not.toContain("<");
      }
    }
    change(rowsOf(hostile)[0]?.querySelector("input") as Element);
    expect(calls).toEqual([`account:team:${evil}`]);
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
    const root = controls(model({ open: "models", filters: { agents: ["codex"], models: [], accounts: [], plans: [] } }));
    expect([...root.querySelectorAll(".pop-group-name")].map(text)).toEqual(["Codex"]);
    expect(text(root.querySelector(".popover .pop-hint"))).toBe("Only models of the selected agents are listed.");
  });

  test("ticking a model reports the exact pair; a selected model is checked", () => {
    const root = controls(model({ open: "models", filters: { agents: [], models: [{ agent: "claude", model: "claude-opus-4-1" }], accounts: [], plans: [] } }));
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
    plans: [],
  });
  const plainAvailable = (): Stats["available"] => ({
    agents: ["claude", ...HOSTILE_IDS.map((_, i) => `plain${i}`)],
    models: [
      { agent: "claude", model: "plain-model", tokens: 10 },
      ...HOSTILE_IDS.map((_, i) => ({ agent: `plain${i}`, model: `m${i}`, tokens: 5 })),
    ],
    accounts: [],
    plans: [],
  });

  test("create exactly the elements plain ids do, show literal text and load only fixed images", () => {
    for (const open of ["agents", "models"] as const) {
      const hostile = controls(model({ open, available: hostileAvailable(), filters: { agents: HOSTILE_IDS.slice(0, 3), models: [], accounts: [], plans: [] } }));
      const plain = controls(model({ open, available: plainAvailable(), filters: { agents: ["plain0", "plain1", "plain2"], models: [], accounts: [], plans: [] } }));
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
    const root = chips({ agents: ["claude", "codex"], models: [{ agent: "claude", model: "opus-4-7" }], accounts: [], plans: [] });
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
    expect(text(chips({ agents: ["codex"], models: [], accounts: [], plans: [] }, "ru").querySelector(".chips-label"))).toBe("Показаны только");
  });

  test("account chips come after agents and models, by display name, and remove that account", () => {
    const root = chips({ agents: ["codex"], models: [{ agent: "claude", model: "opus-4-7" }], accounts: ["team:Devcats", "api"], plans: [] });
    const buttons = [...root.querySelectorAll("button.chip")];
    expect(buttons.map((b) => [text(b), b.getAttribute("aria-label")])).toEqual([
      ["Codex", "Remove filter: Codex"],
      ["opus-4-7", "Remove filter: opus-4-7 (Claude Code)"],
      ["Team · Devcats", "Remove filter: Team · Devcats"],
      ["API key", "Remove filter: API key"],
    ]);
    expect(buttons[2]?.querySelector("img")).toBeNull();
    (buttons[2] as HTMLButtonElement).click();
    expect(calls).toEqual(["account:team:Devcats"]);
    const only = chips({ agents: [], models: [], accounts: ["personal"], plans: [] }, "ru");
    expect(text(only.querySelector(".chips-label"))).toBe("Показаны только");
    expect([...only.querySelectorAll("button.chip")].map((b) => [text(b), b.getAttribute("aria-label")])).toEqual([["Личный", "Убрать фильтр: Личный"]]);
  });

  test("an org with markup is literal text in its chip", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const root = chips({ agents: [], models: [], accounts: [`enterprise:${evil}`], plans: [] });
    expect(text(root.querySelector("button.chip"))).toBe(`Enterprise · ${evil}`);
    expect(root.querySelector("img, script")).toBeNull();
  });

  test("hostile ids are literal text in chips and their labels", () => {
    const root = chips({ agents: HOSTILE_IDS, models: [{ agent: HOSTILE_IDS[3] as string, model: "<b>m</b>" }], accounts: [], plans: [] });
    expect([...root.querySelectorAll("button.chip")].map((b) => text(b))).toEqual([...HOSTILE_IDS.map((id) => id.replace(/\s+/g, " ").trim()), "<b>m</b>"]);
    expect(root.querySelector("img, b, script")).toBeNull();
  });
});

describe("edge cases", () => {
  test("a model of an agent whose id has a colon is listed but cannot be ticked", () => {
    const available: Stats["available"] = { agents: ["x:a"], models: [{ agent: "x:a", model: "b", tokens: 3 }], accounts: [], plans: [] };
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
      plans: [],
    });
    const label = (n: number) =>
      text(
        controls(
          model({ available: available(n), filters: { agents: many(Math.min(n, 20)), models: many(n).map((a) => ({ agent: a, model: "m" })), accounts: [], plans: [] } }),
          "ru",
        ).querySelector("#models-btn"),
      );
    expect([1, 3, 5, 11, 21].map(label)).toEqual(["1 модель", "3 модели", "5 моделей", "11 моделей", "21 модель"]);
  });

  test("nothing in the period: the popovers say so instead of an empty box", () => {
    const empty: Stats["available"] = { agents: [], models: [], accounts: [], plans: [] };
    expect(text(controls(model({ open: "agents", available: empty })).querySelector(".pop-empty"))).toBe("Nothing in this period");
    const models = controls(model({ open: "models", available: empty }));
    expect(text(models.querySelector(".pop-empty"))).toBe("Nothing in this period");
  });

  test("every available agent ticked still reads as a count, not All", () => {
    const root = controls(model({ filters: { agents: ["claude", "codex", "aider"], models: [], accounts: [], plans: [] } }));
    expect(text(root.querySelector("#agents-btn"))).toBe("3 agents");
  });

  test("a selection this member does not have stays listed, ticked, with a zero total, so it can be unticked", () => {
    const memberAvailable: Stats["available"] = { agents: ["claude"], models: [{ agent: "claude", model: "claude-opus-4-1", tokens: 7 }], accounts: [], plans: [] };
    const filters: Filters = { agents: ["claude", "codex"], models: [{ agent: "codex", model: "gpt-5-codex" }], accounts: [], plans: [] };
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
      accounts: [null, { key: "api", tokens: Number.NaN }, { key: "boss", tokens: 1 }],
      plans: [],
    } as unknown as Stats["available"];
    for (const open of ["agents", "models", "accounts"] as const) {
      const root = controls(model({ open, available: bad }));
      expect(root.textContent).not.toContain("NaN");
    }
  });

  test("only the open popover is in the page", () => {
    expect(controls(model({ open: "models" })).querySelectorAll(".popover")).toHaveLength(1);
    expect(controls(model({ open: "accounts" })).querySelectorAll(".popover")).toHaveLength(1);
    expect(controls(model({ open: "accounts" })).querySelector("#models-btn")?.getAttribute("aria-expanded")).toBe("false");
    expect(controls(model({ open: "models" })).querySelector("#agents-btn")?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("plans filter bar", () => {
  test("button reads All plans / N plans and Clear appears", () => {
    const closed = controls(model());
    expect(text(closed.querySelector("#plans-btn"))).toBe("All plans");
    expect(text(controls(model(), "ru").querySelector("#plans-btn"))).toBe("Все тарифы");
    const label = (n: number, lang: "en" | "ru") =>
      text(controls(model({ filters: { ...NO_FILTERS, plans: Array.from({ length: n }, (_, i) => `claude:p${i}`) } }), lang).querySelector("#plans-btn"));
    expect([1, 2, 5].map((n) => label(n, "en"))).toEqual(["1 plan", "2 plans", "5 plans"]);
    expect([1, 2, 5].map((n) => label(n, "ru"))).toEqual(["1 тариф", "2 тарифа", "5 тарифов"]);
    const root = controls(model({ filters: { ...NO_FILTERS, plans: ["none"] } }));
    expect(root.querySelector("#plans-btn")?.classList.contains("selected")).toBe(true);
    (root.querySelector("#clear-filters") as HTMLButtonElement).click();
    expect(calls).toEqual(["clear"]);
  });

  test("popover lists plans by name with totals, reflecting the selection; ticking and Show all report keys", () => {
    const root = controls(model({ open: "plans", filters: { ...NO_FILTERS, plans: ["none"] } }));
    const pop = root.querySelector(".popover") as HTMLElement;
    expect(pop.id).toBe("plans-pop");
    expect(doc.getElementById(pop.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Plans in this period");
    expect(rowsOf(root).map((r) => [text(r.querySelector(".pop-name")), text(r.querySelector(".pop-num")), (r.querySelector("input") as HTMLInputElement).checked])).toEqual([
      ["Claude Team Premium", "51,000", false],
      ["No plan", "5,500", true],
      ["Claude Pro", "4,000", false],
    ]);
    change(rowsOf(root)[0]?.querySelector("input") as Element);
    (pop.querySelector(".pop-head button") as HTMLButtonElement).click();
    expect(calls).toEqual(["plan:claude:team_premium", "all:plans"]);
    expect(text(controls(model({ open: "plans" }), "ru").querySelector(".popover .pop-title"))).toBe("Тарифы за этот период");
  });

  test("limit note, empty, and a selected plan the period lacks stays listed at zero", () => {
    const note = controls(model({ open: "plans", note: { key: "planLimit", vars: { n: 50 } } }));
    expect(text(note.querySelector(".pop-note"))).toBe("You can select up to 50 plans.");
    const empty = controls(model({ open: "plans", available: { agents: [], models: [], accounts: [], plans: [] } }));
    expect(text(empty.querySelector(".pop-empty"))).toBe("Nothing in this period");
    const lacking = controls(model({ open: "plans", available: { ...statsFixture().available, plans: [] }, filters: { ...NO_FILTERS, plans: ["codex:plus"] } }));
    expect(rowsOf(lacking).map((r) => [text(r.querySelector(".pop-name")), text(r.querySelector(".pop-num"))])).toEqual([["ChatGPT Plus", "0"]]);
  });

  test("chips: one per plan, named, removable", () => {
    const chips = renderChips(doc, { ...NO_FILTERS, plans: ["claude:pro", "none"] }, "en", handlers);
    const host = doc.createElement("div");
    host.append(...chips);
    expect([...host.querySelectorAll("button.chip")].map((c) => [text(c), c.getAttribute("aria-label")])).toEqual([
      ["Claude Pro", "Remove filter: Claude Pro"],
      ["No plan", "Remove filter: No plan"],
    ]);
    (host.querySelector("button.chip") as HTMLButtonElement).click();
    expect(calls).toEqual(["plan:claude:pro"]);
  });
});
