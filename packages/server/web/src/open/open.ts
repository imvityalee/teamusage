import type { ApiResult, request } from "../site/http.js";
import type { me } from "../site/session.js";

export type OpenView = "how" | "opening" | "confirm" | "expired" | "adminsOnly" | "failed";

/** The server's refusal of a link whose team shows its dashboard only to admins (src/stats-access.ts). */
const DASHBOARD_ADMINS_ONLY = "this team's dashboard is limited to its admins";
const OPEN_PATH = "/api/dashboard-link/open";
const TOKEN = /^#([a-f0-9]{64})$/;

/** The token of `#<64 hex>`; null for anything else. */
export function tokenOf(hash: string): string | null {
  return TOKEN.exec(hash)?.[1] ?? null;
}

/**
 * `noAccounts`: the server has no GitHub sign-in (self-hosted), so the page offers the invite code instead.
 * `busy`: a press of "Open as a member" or "Try again" is being answered; the view stays as it was meanwhile.
 */
export type Opener = {
  view: OpenView;
  login?: string;
  noAccounts: boolean;
  busy: boolean;
  open(): Promise<void>;
  onChange(listener: () => void): void;
};

type Deps = { token: string | null; me: typeof me; request: typeof request; go(path: "/" | "/dashboard" | "/teams"): void };

/** The view an answer to the link's opening leads to; null when it opened. */
function viewAfter(answer: ApiResult<unknown>): OpenView | null {
  if (answer.kind === "ok") return null;
  if (answer.kind === "network" || answer.kind === "failed") return "failed";
  if (answer.kind === "refused" && answer.status >= 500) return "failed";
  if (answer.kind === "refused" && answer.status === 403 && answer.error === DASHBOARD_ADMINS_ONLY) return "adminsOnly";
  return "expired";
}

/**
 * Decides what `/open` shows and does. `go` navigates with `location.replace`.
 * Nothing is posted while the session is unknown: posting blind could replace a GitHub sign-in without asking.
 */
export function opener(deps: Deps): Opener {
  const { token } = deps;
  const listeners: (() => void)[] = [];
  /** False until `me()` has answered who is signed in. */
  let sessionRead = false;

  // With a token the page starts in "opening": the automatic opening, whose text is drawn after a delay (main.ts).
  const state: Opener = {
    view: token === null ? "how" : "opening",
    noAccounts: false,
    busy: false,
    open,
    onChange: (listener) => void listeners.push(listener),
  };

  function tell(): void {
    for (const listener of listeners) listener();
  }

  /** Shows `view`; any press has been answered. */
  function show(view: OpenView): void {
    state.view = view;
    state.busy = false;
    tell();
  }

  /** Posts the token; on success the page navigates away, so a pressed button stays busy. */
  async function post(link: string): Promise<void> {
    const view = viewAfter(await deps.request("POST", OPEN_PATH, { token: link }));
    if (view === null) deps.go(state.noAccounts ? "/" : "/dashboard");
    else show(view);
  }

  /** Reads the session, then asks a GitHub user first and opens the link for anyone else. */
  async function start(): Promise<void> {
    const answer = await deps.me();
    if (answer.kind === "failed") return show(token === null ? "how" : "failed");
    sessionRead = true;
    state.noAccounts = answer.kind === "noAccounts";
    if (token === null) return show("how");
    if (answer.kind === "me" && answer.me.kind === "user") {
      state.login = answer.me.login;
      return show("confirm");
    }
    return post(token);
  }

  /** "Open as a member" and "Try again": opens the link, or first reads the session when it could not be read. */
  async function open(): Promise<void> {
    if (token === null || state.busy || state.view === "opening") return;
    state.busy = true;
    tell();
    return sessionRead ? post(token) : start();
  }

  void start();
  return state;
}
