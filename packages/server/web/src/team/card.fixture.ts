import { Window } from "happy-dom";
import { vi } from "vitest";
import type { Lang } from "../lang.js";
import { stubBrowser, type Reply } from "../site/page.fixture.js";
import type { TeamInfo } from "./api.js";
import type { TeamContext } from "./card.js";

/** One card of the team page on its own, in happy-dom, with stubbed answers and clipboard (tests only). */

export type World = ReturnType<typeof makeWorld>;
type Clipboard = ReturnType<typeof fakeClipboard>;

/** A `ClipboardItem` as a browser takes it: each type's data may be a promise. */
class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob> | Blob | string>) {}
}

/**
 * A clipboard that keeps what it is given (`held`), or refuses. `write` (with `ClipboardItem`) exists only when asked
 * for, as in a browser that has it; it waits for the item's text like a browser does.
 */
function fakeClipboard(refuse: boolean) {
  let held: string | null = null;
  const refuseNow = () => {
    if (refuse) throw new Error("NotAllowedError");
  };
  return {
    held: () => held,
    writeText: vi.fn(async (text: string) => {
      refuseNow();
      held = text;
    }),
    write: vi.fn(async ([item]: FakeClipboardItem[]) => {
      const data = await item?.items["text/plain"];
      refuseNow();
      held = typeof data === "string" ? data : ((await data?.text()) ?? null);
    }),
  };
}

function makeWorld(win: Window, team: TeamInfo, lang: Lang, clipboard: Clipboard, stubs: ReturnType<typeof stubBrowser>) {
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
    writeText: clipboard.writeText,
    write: clipboard.write,
    /** What the clipboard holds now. */
    held: clipboard.held,
    ...stubs,
    setLang(next: Lang) {
      language = next;
    },
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

/**
 * A window at `/team?team=<id>` with a clipboard that takes what it is given. `refuseClipboard` makes it refuse;
 * `clipboardItem` gives the browser `ClipboardItem` and `clipboard.write`, as Safari and Chrome have.
 */
export function cardWorld(team: TeamInfo, replies: Reply[], o: { lang?: Lang; refuseClipboard?: boolean; clipboardItem?: boolean } = {}): World {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const win = new Window({ url: `http://localhost:8787/team?team=${team.id}` });
  const clipboard = fakeClipboard(o.refuseClipboard === true);
  const api = o.clipboardItem === true ? { writeText: clipboard.writeText, write: clipboard.write } : { writeText: clipboard.writeText };
  Object.defineProperty(win.navigator, "clipboard", { value: api, configurable: true });
  const stubs = stubBrowser(win, replies);
  if (o.clipboardItem === true) vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  return makeWorld(win, team, o.lang ?? "en", clipboard, stubs);
}

