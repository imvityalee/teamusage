import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { copyWith } from "../site/copy.js";
import type { Card, TeamContext } from "./card.js";
import { tt } from "./strings.js";

/**
 * The invite message card: the message to send the team, in English or Russian by the card's own EN/RU control, which
 * starts at the page's language and changes nothing else. The choice is not stored. The message never holds the code.
 */

/** The message in `lang`, naming the server at `origin` (this page's own origin), as text. */
export const messageText = (lang: Lang, origin: string): string => tt(lang, "message", { origin });

const LANGS: Lang[] = ["en", "ru"];

export function inviteMessage(ctx: TeamContext): Card {
  const { doc } = ctx;
  const title = h(doc, "h2", { id: "invite-title" });
  const note = h(doc, "p", { class: "card-note" });
  const choices = LANGS.map((lang) => h(doc, "button", { type: "button", "data-message-lang": lang, lang }, lang.toUpperCase()));
  const group = h(doc, "div", { class: "seg", id: "invite-lang", role: "group" }, ...choices);
  const text = h(doc, "pre", { id: "invite-text", class: "message" });
  const copyButton = h(doc, "button", { type: "button", id: "invite-copy", class: "btn quiet compact" }) as HTMLButtonElement;
  const error = h(doc, "p", { id: "invite-error", class: "notice warn", role: "alert", hidden: "" });
  const element = h(doc, "section", { id: "invite-card", class: "card", "aria-labelledby": "invite-title" },
    h(doc, "div", { class: "card-head" }, h(doc, "div", { class: "card-text" }, title, note), group),
    text,
    error,
    h(doc, "div", {}, copyButton),
  );

  /** The language the person chose for the message; null follows the page's. */
  let chosen: Lang | null = null;
  let copyFailed = false;
  const messageLang = (): Lang => chosen ?? ctx.lang();

  function paint(): void {
    const lang = ctx.lang();
    title.textContent = tt(lang, "inviteTitle");
    note.textContent = tt(lang, "inviteNote");
    group.setAttribute("aria-label", tt(lang, "messageLanguage"));
    for (const b of choices) b.setAttribute("aria-pressed", String(b.dataset.messageLang === messageLang()));
    text.setAttribute("lang", messageLang());
    text.textContent = messageText(messageLang(), location.origin);
    copyButton.textContent = tt(lang, "copyMessage");
    error.hidden = !copyFailed;
    error.textContent = copyFailed ? tt(lang, "copyMessageFailed") : "";
  }

  group.addEventListener("click", (e) => {
    const value = (e.target as Element | null)?.closest<HTMLElement>("button[data-message-lang]")?.dataset.messageLang;
    if (value !== "en" && value !== "ru") return;
    chosen = value;
    paint();
  });
  copyButton.addEventListener("click", async () => {
    copyFailed = false;
    paint();
    copyFailed = !(await copyWith(copyButton, text.textContent ?? "", tt(ctx.lang(), "copied")));
    if (copyFailed) paint();
  });
  paint();
  return { element, paint };
}
