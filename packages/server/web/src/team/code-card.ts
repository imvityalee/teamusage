import { h } from "../dom.js";
import { copyWhenReady, copyWith } from "../site/copy.js";
import type { ApiResult } from "../site/http.js";
import { getCode, replaceCode } from "./api.js";
import type { Card, TeamContext } from "./card.js";
import { openFlow } from "./dialog-flow.js";
import { failureText } from "./failure.js";
import { tt, type TeamKey } from "./strings.js";

/**
 * The team code card. The code is asked for only when someone presses Show or Copy; it is drawn as text and nowhere
 * else (no attribute, no title, no storage, no console), and Hide drops it from the page and from memory.
 */

export const HIDDEN_CODE = "•".repeat(24);

/** The server's refusal of a code it can no longer show (`src/routes-team-settings.ts`, which a test compares). */
export const CODE_NOT_SHOWN = "this code can no longer be shown; rotate it";

export type CodeCard = { shown: string | null; show(): Promise<void>; hide(): void; copy(button: HTMLButtonElement): Promise<void>; replaced(code: string): void };

const isCode = (v: unknown): v is { code: string } => typeof (v as { code?: unknown } | null)?.code === "string";

export function codeCard(ctx: TeamContext): CodeCard & Card {
  const { doc } = ctx;
  const button = (id: string, cls: string) => h(doc, "button", { type: "button", id, class: `btn ${cls} compact` }) as HTMLButtonElement;
  const title = h(doc, "h2", { id: "code-title" });
  const note = h(doc, "p", { class: "card-note" });
  const value = h(doc, "code", { id: "code-value", class: "code team-code", "aria-live": "polite" });
  const showButton = button("code-show", "quiet");
  const copyButton = button("code-copy", "primary");
  const replaceButton = button("code-replace", "quiet");
  const error = h(doc, "p", { id: "code-error", class: "notice warn", role: "alert", hidden: "" });
  const replaceNote = h(doc, "p", { class: "small" });
  const element = h(doc, "section", { id: "code-card", class: "card", "aria-labelledby": "code-title" },
    h(doc, "div", {}, title, note),
    h(doc, "div", { class: "code-row" }, value, showButton, copyButton, replaceButton),
    error,
    replaceNote,
  );

  let shown: string | null = null;
  let busy = false;
  /** What went wrong last, drawn in the page's language when it paints. */
  let problem: TeamKey | ApiResult<unknown> | null = null;

  /** What the code box holds: the code, or the dots with "Hidden" in a language. It is drawn again only when that changes, so its live region speaks once. */
  let drawn: string | null = null;

  function paintValue(): void {
    const next = shown ?? `hidden:${ctx.lang()}`;
    if (next === drawn) return;
    drawn = next;
    if (shown !== null) return value.replaceChildren(shown);
    value.replaceChildren(h(doc, "span", { "aria-hidden": "true" }, HIDDEN_CODE), h(doc, "span", { class: "sr" }, tt(ctx.lang(), "codeHidden")));
  }

  function paint(): void {
    const lang = ctx.lang();
    title.textContent = tt(lang, "codeTitle");
    note.textContent = tt(lang, "codeNote");
    replaceNote.textContent = tt(lang, "replaceNote");
    showButton.textContent = tt(lang, shown === null ? "show" : "hide");
    copyButton.textContent = tt(lang, "copyCode");
    replaceButton.textContent = tt(lang, "replaceCode");
    showButton.disabled = copyButton.disabled = busy;
    paintValue();
    error.hidden = problem === null;
    error.textContent = problem === null ? "" : typeof problem === "string" ? tt(lang, problem) : failureText(lang, problem);
  }

  /** Asks for the code, one request at a time: null when it did not come, with what went wrong drawn. */
  async function fetchCode(): Promise<string | null> {
    busy = true;
    problem = null;
    paint();
    const result = await getCode(ctx.team().id);
    busy = false;
    if (result.kind === "unauthorized") {
      hide();
      ctx.signedOut();
      return null;
    }
    if (result.kind === "ok" && isCode(result.value)) return result.value.code;
    problem = result.kind === "refused" && result.status === 409 && result.error === CODE_NOT_SHOWN ? "codeNotShown" : result;
    paint();
    return null;
  }

  async function show(): Promise<void> {
    if (busy) return;
    shown = await fetchCode();
    paint();
    showButton.focus();
  }

  function hide(): void {
    shown = null;
    paint();
  }

  /** After a copy of a code that came: a clipboard that refused is said in the card. */
  function copied(ok: boolean): void {
    if (ok) return;
    problem = "copyCodeFailed";
    paint();
  }

  /**
   * Copies the shown code; a hidden one is asked for and copied without being shown. The clipboard write starts inside
   * the press, before the code's answer (Safari takes no write after it); a code that does not come writes nothing.
   */
  async function copy(pressed: HTMLButtonElement): Promise<void> {
    if (busy) return;
    const done = tt(ctx.lang(), "copied");
    if (shown !== null) return copied(await copyWith(pressed, shown, done));
    const asked = fetchCode();
    const copying = copyWhenReady(pressed, asked.then((code) => code ?? Promise.reject(new Error("no code"))), done);
    const code = await asked;
    paint();
    pressed.focus();
    const ok = await copying;
    if (code !== null) copied(ok);
  }

  function replaced(code: string): void {
    shown = code;
    problem = null;
    paint();
  }

  function askToReplace(): void {
    const lang = ctx.lang();
    const flow = openFlow(ctx, {
      title: tt(lang, "replaceTitle"),
      content: [h(doc, "p", {}, tt(lang, "replaceText"))],
      confirm: tt(lang, "replaceConfirm"),
      busy: tt(lang, "replacing"),
      tone: "primary",
      opener: replaceButton,
      async onConfirm() {
        const result = await flow.send(() => replaceCode(ctx.team().id));
        if (result === null) return hide();
        if (result.kind === "ok" && isCode(result.value)) {
          replaced(result.value.code);
          return flow.dialog.close();
        }
        flow.fail(failureText(ctx.lang(), result));
      },
    });
  }

  showButton.addEventListener("click", () => void (shown === null ? show() : hide()));
  copyButton.addEventListener("click", () => void copy(copyButton));
  replaceButton.addEventListener("click", askToReplace);
  paint();
  return {
    element,
    paint,
    get shown() {
      return shown;
    },
    show,
    hide,
    copy,
    replaced,
  };
}
