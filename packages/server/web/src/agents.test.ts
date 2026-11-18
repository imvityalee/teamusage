import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";
import { agentIcon, agentName, agentLogo, agentStyle, badgeLetters, LOGO_PATHS, OTHER_SERIES, SERIES, SERIES_CLASS, seriesOf } from "./agents.js";
import { HOSTILE_IDS } from "./test-fixtures.js";

const doc = () => new Window().document as unknown as Document;

describe("fixed identity per agent", () => {
  test("the five known agents have a fixed colour, name and icon", () => {
    expect(["claude", "codex", "gemini", "opencode", "copilot"].map((id) => [agentName(id), agentStyle(id)])).toEqual([
      ["Claude Code", { colour: "ag-claude", logo: "/agents/claudecode.svg", letters: "Cl" }],
      ["Codex", { colour: "ag-codex", logo: null, letters: "Cx" }],
      ["Gemini CLI", { colour: "ag-gemini", logo: "/agents/googlegemini.svg", letters: "Ge" }],
      ["OpenCode", { colour: "ag-opencode", logo: "/agents/opencode.svg", letters: "Op" }],
      ["Copilot", { colour: "ag-copilot", logo: "/agents/githubcopilot.svg", letters: "Co" }],
    ]);
  });

  test("other agents are grey; a few have a logo by exact id, the rest a lettered badge", () => {
    for (const id of ["cursor", "cline", "kimi", "qwen", "deepseek", "ollama"]) {
      expect(agentStyle(id)).toEqual({ colour: "ag-other", logo: `/agents/${id}.svg`, letters: badgeLetters(id) });
    }
    expect(agentStyle("aider")).toEqual({ colour: "ag-other", logo: null, letters: "Ai" });
    expect(agentStyle("Cursor").logo).toBeNull();
  });

  test("hostile ids get the grey colour, no logo and letters only from their letters", () => {
    for (const id of HOSTILE_IDS) {
      const s = agentStyle(id);
      expect([id, s.colour, s.logo]).toEqual([id, "ag-other", null]);
      expect(s.letters).toMatch(/^(\?|[\p{L}\p{N}]{1,2})$/u);
    }
    expect(badgeLetters("../../x")).toBe("X");
    expect(badgeLetters("__proto__")).toBe("Pr");
    expect(badgeLetters("constructor")).toBe("Co");
    expect(badgeLetters(`claude"><img src=x onerror=alert(1)>`)).toBe("Cl");
    expect(badgeLetters("a".repeat(64))).toBe("Aa");
    expect(badgeLetters("кодекс")).toBe("Ко");
    expect(badgeLetters("--")).toBe("?");
    expect(badgeLetters("")).toBe("?");
  });

  test("logo paths are a fixed set of same-origin files", () => {
    expect([...LOGO_PATHS].sort()).toEqual(
      ["claudecode", "cline", "cursor", "deepseek", "githubcopilot", "googlegemini", "kimi", "ollama", "opencode", "qwen"].map((n) => `/agents/${n}.svg`),
    );
  });
});

describe("chart series", () => {
  test("bottom to top: the five known agents in a fixed order, then one shared series for all others", () => {
    expect(SERIES).toEqual(["claude", "codex", "gemini", "opencode", "copilot"]);
    expect(["copilot", "claude", "cursor", "__proto__", "codex"].map(seriesOf)).toEqual([4, 0, OTHER_SERIES, OTHER_SERIES, 1]);
    expect(OTHER_SERIES).toBe(5);
    expect(SERIES_CLASS).toEqual(["ag-claude", "ag-codex", "ag-gemini", "ag-opencode", "ag-copilot", "ag-other"]);
  });
});

describe("icon elements", () => {
  test("a known agent's tile is decorative, carries its colour class and a same-origin logo", () => {
    const icon = agentIcon(doc(), "claude");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.className).toBe("agent-icon ag-claude");
    const img = icon.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/agents/claudecode.svg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.className).toBe("logo");
  });

  test("Codex and unknown agents get letters, never an image", () => {
    const cx = agentIcon(doc(), "codex");
    expect(cx.querySelector("img")).toBeNull();
    expect(cx.textContent).toBe("Cx");
    for (const id of HOSTILE_IDS) {
      const icon = agentIcon(doc(), id);
      expect(icon.className).toBe("agent-icon ag-other");
      expect(icon.children).toHaveLength(0);
      expect(icon.textContent).toBe(badgeLetters(id));
      expect(agentLogo(doc(), id)).toBeNull();
    }
  });

  test("the plain logo is a decorative same-origin image", () => {
    const img = agentLogo(doc(), "gemini") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/agents/googlegemini.svg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(agentLogo(doc(), "codex")).toBeNull();
  });
});
