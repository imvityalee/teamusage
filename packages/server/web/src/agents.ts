/**
 * The fixed identity of each agent: display name, colour and icon. Agent ids come from the server and are data:
 * they are only ever looked up in the fixed maps below, never used to build a path, class, id or style.
 */

const NAMES = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["gemini", "Gemini CLI"],
  ["opencode", "OpenCode"],
  ["copilot", "Copilot"],
]);

/** Display name for a known agent id, otherwise the id itself. */
export function agentName(id: string): string {
  return NAMES.get(id) ?? String(id);
}

/** Chart series, bottom to top. The order and colours were validated together; do not reorder. */
export const SERIES: readonly string[] = ["claude", "codex", "gemini", "opencode", "copilot"];
/** The one shared series for every other agent. */
export const OTHER_SERIES = SERIES.length;
/** CSS class per series; the last is the grey "other agents". */
export const SERIES_CLASS: readonly string[] = ["ag-claude", "ag-codex", "ag-gemini", "ag-opencode", "ag-copilot", "ag-other"];

const SERIES_INDEX = new Map(SERIES.map((id, i) => [id, i]));

/** The series an agent is drawn in: its own for the five known agents, the shared one for the rest. */
export function seriesOf(id: string): number {
  return SERIES_INDEX.get(id) ?? OTHER_SERIES;
}

/** Same-origin logo files from simple-icons, by exact agent id. Licences: see public/agents/NOTICE.md. */
const LOGOS = new Map([
  ["claude", "/agents/claudecode.svg"],
  ["gemini", "/agents/googlegemini.svg"],
  ["opencode", "/agents/opencode.svg"],
  ["copilot", "/agents/githubcopilot.svg"],
  ["cursor", "/agents/cursor.svg"],
  ["cline", "/agents/cline.svg"],
  ["kimi", "/agents/kimi.svg"],
  ["qwen", "/agents/qwen.svg"],
  ["deepseek", "/agents/deepseek.svg"],
  ["ollama", "/agents/ollama.svg"],
]);

/** Every image path the page may load for an agent. */
export const LOGO_PATHS: ReadonlySet<string> = new Set(LOGOS.values());

/** Agents with neither a logo nor a two-letter abbreviation of their id. */
const LETTERS = new Map([["codex", "Cx"]]);

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** One character in the given case, or unchanged when the case change would make it longer ("ß" → "SS"). */
function oneChar(c: string, upper: boolean): string {
  const changed = upper ? c.toUpperCase() : c.toLowerCase();
  return [...changed].length === 1 ? changed : c;
}

/** The first one or two letters or digits of an id ("__proto__" → "Pr"), or "?" when it has none. */
export function badgeLetters(id: string): string {
  const chars = [...String(id)].filter((c) => LETTER_OR_DIGIT.test(c)).slice(0, 2);
  if (chars.length === 0) return "?";
  return oneChar(chars[0] as string, true) + (chars[1] === undefined ? "" : oneChar(chars[1], false));
}

export interface AgentStyle {
  /** One of SERIES_CLASS. */
  colour: string;
  /** One of LOGO_PATHS, or null for a lettered badge. */
  logo: string | null;
  letters: string;
}

export function agentStyle(id: string): AgentStyle {
  return {
    colour: SERIES_CLASS[seriesOf(id)] as string,
    logo: LOGOS.get(id) ?? null,
    letters: LETTERS.get(id) ?? badgeLetters(id),
  };
}

function logoImage(doc: Document, src: string, className: string): HTMLImageElement {
  const img = doc.createElement("img");
  img.className = className;
  img.setAttribute("src", src);
  img.setAttribute("alt", "");
  img.setAttribute("width", "13");
  img.setAttribute("height", "13");
  return img;
}

/**
 * The decorative agent tile: a soft square with a strip in the agent's colour and its logo or letters.
 * The agent's name is always shown as text next to it.
 */
export function agentIcon(doc: Document, id: string): HTMLElement {
  const s = agentStyle(id);
  const tile = doc.createElement("span");
  tile.className = `agent-icon ${s.colour}`;
  tile.setAttribute("aria-hidden", "true");
  if (s.logo !== null) tile.append(logoImage(doc, s.logo, "logo"));
  else tile.textContent = s.letters;
  return tile;
}

/** The tile for the shared "other agents" series: grey, no logo, no letters. */
export function otherAgentsIcon(doc: Document): HTMLElement {
  const tile = doc.createElement("span");
  tile.className = `agent-icon ${SERIES_CLASS[OTHER_SERIES]}`;
  tile.setAttribute("aria-hidden", "true");
  return tile;
}

/** The bare logo, for small places such as chips and group headings; null when the agent has none. */
export function agentLogo(doc: Document, id: string): HTMLImageElement | null {
  const src = LOGOS.get(id);
  if (src === undefined) return null;
  const img = logoImage(doc, src, "agent-logo");
  img.setAttribute("aria-hidden", "true");
  return img;
}
