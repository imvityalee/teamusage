import type { Lang } from "../lang.js";
import type { request as send } from "../site/http.js";
import type { translator } from "../site/i18n.js";
import { teamPath } from "../site/team-param.js";
import { checkForm, createOutcome, type CreateError } from "./create-form.js";
import type { TeamsKey } from "./strings.js";
import { atMostLine, MAX_OWNED } from "./teams.js";

/** The "Name your team" form: reads the fields, shows each problem beside its field once Create team is pressed, sends the request. */

type T = ReturnType<typeof translator<TeamsKey>>;
type Deps = {
  doc: Document;
  t: T;
  lang(): Lang;
  request: typeof send;
  /** Navigates to a page and keeps it in the history. */
  assign(path: string): void;
  /** The server did not know the person: the page shows its sign-in panel. */
  onSignedOut(): void;
};

/** A refusal that belongs to no field; it is shown in the page's own sentence and the server's text is never drawn. */
type Notice = Exclude<CreateError, "name">;
const NOTICE_KEY = { paused: "errorPaused", failed: "errorFailed", network: "errorNetwork" } as const;

export type FormView = { paint(): void };

export function formView(deps: Deps): FormView {
  const { doc, t } = deps;
  const byId = <E extends HTMLElement>(id: string) => doc.getElementById(id) as E;
  const form = byId<HTMLFormElement>("create-form");
  const name = byId<HTMLInputElement>("team-name");
  const nameError = byId("name-error");
  const accessError = byId("access-error");
  const notice = byId("form-notice");
  const button = byId<HTMLButtonElement>("create");
  const radios = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="dashboard-access"]'));

  let busy = false;
  let problem: { name: boolean; access: boolean; notice: Notice | null } = { name: false, access: false, notice: null };

  const chosen = (): string | null => radios.find((r) => r.checked)?.value ?? null;

  function paint(): void {
    const lang = deps.lang();
    nameError.hidden = !problem.name;
    name.setAttribute("aria-invalid", String(problem.name));
    accessError.hidden = !problem.access;
    notice.hidden = problem.notice === null;
    if (problem.notice !== null) notice.textContent = noticeText(problem.notice, lang);
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    button.textContent = t(lang, busy ? "creating" : "create");
  }

  function noticeText(kind: Notice, lang: Lang): string {
    if (kind !== "ownsMost") return t(lang, NOTICE_KEY[kind]);
    const { key, vars } = atMostLine(lang, MAX_OWNED);
    return t(lang, key, vars);
  }

  /** Focus goes to the field at fault, or back to the button, which a browser dropped while it was disabled. */
  function focusFault(): void {
    if (problem.name) name.focus();
    else if (problem.access) radios[0]?.focus();
    else button.focus();
  }

  async function submit(): Promise<void> {
    if (busy) return;
    const found = checkForm(name.value, chosen());
    problem = { name: found === "name", access: found === "access", notice: null };
    if (found !== null) {
      paint();
      return focusFault();
    }
    busy = true;
    paint();
    const outcome = createOutcome(await deps.request("POST", "/api/teams", { name: name.value.trim(), dashboardAccess: chosen() }));
    if (outcome.kind === "created") return deps.assign(teamPath(outcome.team));
    busy = false;
    if (outcome.kind === "signedOut") return deps.onSignedOut();
    problem = { name: outcome.error === "name", access: false, notice: outcome.error === "name" ? null : outcome.error };
    paint();
    focusFault();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  name.addEventListener("input", () => {
    problem.name = false;
    paint();
  });
  for (const r of radios) {
    r.addEventListener("change", () => {
      problem.access = false;
      paint();
    });
  }
  return { paint };
}
