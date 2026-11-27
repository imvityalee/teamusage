import type { Stats } from "@teamusage/shared";
import { Window } from "happy-dom";
import type { Filters } from "./filters.js";
import { NO_FILTERS } from "./filters.js";
import { renderStats } from "./render.js";
import { statsFixture } from "./test-fixtures.js";

/** What the render tests of the dashboard share (tests only): the day they draw on, a document, and readers of the drawn tables. */

export const TODAY = "2026-11-18";
export const CODEX_ONLY: Filters = { agents: ["codex"], models: [], accounts: [], plans: [] };

export function newDocument(): Document {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true } });
  return window.document as unknown as Document;
}

export function render(stats = statsFixture(), lang: "en" | "ru" = "en", filters: Filters = NO_FILTERS): HTMLElement {
  const doc = newDocument();
  const host = doc.createElement("div");
  host.append(renderStats(doc, stats, lang, TODAY, { filters }));
  return host;
}

/** The fixture as the server answers with `agent=codex`: the same `available`, only Codex in the numbers. */
export function codexOnly(): Stats {
  const s = statsFixture();
  return {
    ...s,
    totals: { tokens: 5_000, costUsd: 1.5, activeMembers: 2, memberCount: 3 },
    daily: s.daily.map((d) => ({ date: d.date, byAgent: { codex: 500 } })),
    members: s.members.map((m, i): Stats["members"][number] => {
      const codex = [4_500, 500, 0][i] ?? 0;
      return { ...m, tokens: codex, costUsd: 0, byAgent: codex > 0 ? { codex } : {} };
    }),
    models: s.models.filter((m) => m.agent === "codex"),
  };
}

export const tags = (root: Element) => [...root.querySelectorAll("*")].map((e) => e.tagName.toLowerCase());
export const rows = (root: Element, id: string) => [...root.querySelectorAll(`#${id} tbody tr`)];
export const cells = (row: Element) => [...row.querySelectorAll("th, td")].map((c) => c.textContent?.trim());
/** [initials, name, email] of a members row. */
export const who = (row: Element) => [
  row.querySelector(".avatar")?.textContent,
  row.querySelector(".who a, .who b")?.textContent,
  row.querySelector(".who .email")?.textContent,
];

export const HOSTILE = {
  name: `<img src=x onerror="alert(1)">`,
  email: `"><script>alert('e')</script>&amp;`,
  agent: `<svg onload=alert(2)></title><script>alert(3)</script>`,
  model: `</script><iframe src="javascript:alert(4)"></iframe>&lt;`,
};
