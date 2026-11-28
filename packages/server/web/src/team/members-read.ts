import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import type { ApiResult } from "../site/http.js";
import { getMembers, isApiMember } from "./api.js";
import type { TeamContext } from "./card.js";
import { failureText } from "./failure.js";
import { toRows, type MemberRow } from "./members.js";
import { tt } from "./strings.js";

/** Reading the members: the request, the answer that is no longer the latest, and the alert with Try again. */

export type MembersReader = {
  /** The alert and its Try again button, for the card to put in its element. */
  error: HTMLElement;
  retry: HTMLButtonElement;
  /** Reads the list. A 401 is the page's, a lost role reloads the page, anything else is told in the alert. */
  read(): Promise<void>;
  /** What went wrong with the last reading, or null. */
  problem(): ApiResult<unknown> | null;
  /** Draws the alert and the button in `lang`. */
  paint(lang: Lang): void;
};

/** An answer that says the caller has no role in this team (any more). */
const lostRole = (result: ApiResult<unknown>): boolean => result.kind === "refused" && (result.status === 403 || result.status === 404);

/**
 * `accept` takes the rows of a list that was read; `changed` is called after every reading that the card has to draw;
 * `refocus` is where focus goes when Try again has worked and its button leaves.
 */
export function membersReader(ctx: TeamContext, o: { today(): string; accept(rows: MemberRow[]): void; changed(): void; refocus: HTMLElement }): MembersReader {
  const { doc } = ctx;
  const error = h(doc, "p", { id: "members-error", class: "notice warn", role: "alert", hidden: "" });
  const retry = h(doc, "button", { type: "button", id: "members-retry", class: "btn quiet compact", hidden: "" }) as HTMLButtonElement;
  let problem: ApiResult<unknown> | null = null;
  /** Counts the readings, so that an answer that is no longer the latest is dropped. */
  let reading = 0;

  async function read(): Promise<void> {
    const mine = ++reading;
    const result = await getMembers(ctx.team().id);
    if (mine !== reading) return;
    if (result.kind === "unauthorized") return ctx.signedOut();
    if (lostRole(result)) return void ctx.reload();
    const list = result.kind === "ok" ? (result.value as { members?: unknown }).members : null;
    if (Array.isArray(list) && list.every(isApiMember)) {
      problem = null;
      o.accept(toRows(list, o.today()));
    } else problem = result;
    o.changed();
  }

  retry.addEventListener("click", async () => {
    const hadFocus = doc.activeElement === retry;
    retry.disabled = true;
    await read();
    retry.disabled = false;
    if (hadFocus) (problem === null ? o.refocus : retry).focus();
  });

  return {
    error,
    retry,
    read,
    problem: () => problem,
    paint(lang) {
      error.hidden = problem === null;
      error.textContent = problem === null ? "" : `${tt(lang, "membersLoadFailed")} ${failureText(lang, problem)}`;
      retry.hidden = problem === null;
      retry.textContent = tt(lang, "tryAgain");
    },
  };
}
