import { expect, vi } from "vitest";
import type { Lang } from "../lang.js";
import { json, type Reply } from "../site/page.fixture.js";
import { cardWorld, type World } from "./card.fixture.js";
import type { MemberRow } from "./members.js";
import { machine, member, rowsOf, TODAY } from "./members.fixture.js";
import { T, teamInfo } from "./page.fixture.js";
import { openRemoval, type RemovalOptions } from "./removal-dialog.js";
import type { RemovalTarget } from "./removal.js";

/** The removal dialog on its own, in happy-dom, with stubbed answers (tests only). */

export const NEW_CODE = "7f3a09c1d2e84b56a0f1c21e";

const nurlan: MemberRow = rowsOf([member(7, [machine("2026-10-17", "nurlan-laptop")], { name: "Nurlan Asanov", email: "nurlan.asanov@acme.example" })])[0]!;
export const ONE_MEMBER: RemovalTarget = { members: [nurlan], machines: [] };
export const SEVERAL: RemovalTarget = { members: rowsOf([member(11, [machine(TODAY)]), member(12, [machine(TODAY), machine(TODAY)])]), machines: [] };
export const ONE_MACHINE: RemovalTarget = { members: [], machines: [{ member: nurlan, machine: nurlan.machines[0]! }] };

export const removed = (members: number, machines: number, code?: string) => json(code === undefined ? { removed: { members, machines } } : { removed: { members, machines }, code });

export type Mounted = ReturnType<typeof mount>;

/** A world with an opener button and the members card's heading in the page; `replies` answer the removals in order. */
export function mount(replies: Reply[], o: { lang?: Lang; refuseClipboard?: boolean } = {}) {
  const world: World = cardWorld(teamInfo("admin"), replies, o);
  const { doc, win } = world;
  const opener = doc.createElement("button");
  const refocus = doc.createElement("h2");
  refocus.tabIndex = -1;
  doc.body.append(refocus, opener);
  const onDone = vi.fn<RemovalOptions["onDone"]>();
  const onSignedOut = vi.fn();
  const onRoleLost = vi.fn();
  const onCodeAsked = vi.fn();
  const dialog = () => doc.querySelector<HTMLDialogElement>("dialog[open]");
  const within = (sel: string) => dialog()?.querySelector<HTMLElement>(sel) ?? null;
  const button = (label: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === label && !b.hidden) ?? null;
  return {
    world,
    opener,
    refocus,
    onDone,
    onSignedOut,
    onRoleLost,
    onCodeAsked,
    dialog,
    within,
    button,
    box: () => within("input[type=checkbox]") as HTMLInputElement,
    open(target: RemovalTarget = ONE_MEMBER, lang: Lang = o.lang ?? "en") {
      opener.focus();
      openRemoval(doc, { team: T, target, lang, today: TODAY, opener, refocus, onDone, onSignedOut, onRoleLost, onCodeAsked });
    },
    /** Presses the dialog's button that reads `label` and lets the answer come. */
    async press(label: string) {
      const b = button(label);
      expect(b, `a button "${label}"`).not.toBeNull();
      b!.click();
      await world.flush();
    },
    /** What each request sent: its method, path and body. */
    sent: () => world.calls.map((c) => ({ method: c.init.method, path: c.url, body: JSON.parse(String(c.init.body)) as unknown })),
    /** Escape (and Android's back), as a browser reports it to a dialog. */
    escape() {
      dialog()?.dispatchEvent(new win.Event("cancel", { cancelable: true }) as unknown as Event);
    },
    /** A press on the backdrop: on the dialog element, outside its box. */
    backdrop() {
      const el = dialog();
      if (el === null) return;
      el.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200, x: 100, y: 100 }) as DOMRect;
      el.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 }) as unknown as Event);
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }) as unknown as Event);
    },
    text: () => dialog()?.textContent ?? "",
  };
}
