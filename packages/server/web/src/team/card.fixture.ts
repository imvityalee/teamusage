import { Window } from "happy-dom";
import { vi } from "vitest";
import type { Lang } from "../lang.js";
import { stubBrowser, type Reply } from "../site/page.fixture.js";
import type { TeamInfo } from "./api.js";
import type { TeamContext } from "./card.js";

/** One card of the team page on its own, in happy-dom, with stubbed answers and clipboard (tests only). */

export type World = ReturnType<typeof makeWorld>;

function makeWorld(win: Window, team: TeamInfo, lang: Lang, writeText: ReturnType<typeof vi.fn>, stubs: ReturnType<typeof stubBrowser>) {
  const doc = win.document as unknown as Document;
  let current = team;
  let language = lang;
  const ctx = {
    doc,
    lang: () => language,
    team: () => current,
    update: vi.fn((next: TeamInfo) => void (current = next)),
    signedOut: vi.fn(),
    go: vi.fn(),
  } satisfies TeamContext;
  return {
    win,
    doc,
    ctx,
    writeText,
    ...stubs,
    setLang(next: Lang) {
      language = next;
    },
    /** Every request's address and body, in one string. */
    sent: () => stubs.calls.map((c) => `${c.url} ${String(c.init.body ?? "")}`).join(" "),
    flush: async () => {
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    },
    close: async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await win.happyDOM.close();
    },
  };
}

/** A window at `/team?team=<id>` with a clipboard that takes what it is given; `refuseClipboard` makes it refuse. */
export function cardWorld(team: TeamInfo, replies: Reply[], o: { lang?: Lang; refuseClipboard?: boolean } = {}): World {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const win = new Window({ url: `http://localhost:8787/team?team=${team.id}` });
  const writeText = vi.fn(async (_text: string) => {
    if (o.refuseClipboard === true) throw new Error("NotAllowedError");
  });
  Object.defineProperty(win.navigator, "clipboard", { value: { writeText }, configurable: true });
  const stubs = stubBrowser(win, replies);
  return makeWorld(win, team, o.lang ?? "en", writeText, stubs);
}
