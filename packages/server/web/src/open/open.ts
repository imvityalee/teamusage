import type { ApiResult, request } from "../site/http.js";
import type { me } from "../site/session.js";

export type OpenView = "how" | "opening" | "confirm" | "expired" | "adminsOnly" | "failed";

/** The refusals of `/api/dashboard-link/open` the page knows (src/routes-member-sign-in.ts, src/stats-access.ts, src/http.ts). */
const LINK_NOT_VALID = "this link is no longer valid; ask your agent for a new one";
const DASHBOARD_ADMINS_ONLY = "this team's dashboard is limited to its admins";
const CROSS_SITE = "cross-site request refused";
const OPEN_PATH = "/api/dashboard-link/open";

/** Why the view is `failed`: the server was not reached, it opens links only from its own address, or another refusal with its text. */
export type OpenFailure = { kind: "unreachable" } | { kind: "wrongAddress" } | { kind: "refused"; error: string };
const UNREACHABLE: OpenFailure = { kind: "unreachable" };

/**
 * `noAccounts`: the server has no GitHub sign-in (self-hosted), so the page offers the invite code instead.
 * `busy`: a press of "Open as a member" or "Try again" is being answered; the view stays as it was meanwhile.
 */
export type Opener = {
  view: OpenView;
  /** Read only while the view is `failed`. */
  failure: OpenFailure;
  login?: string;
  noAccounts: boolean;
  busy: boolean;
  open(): Promise<void>;
  onChange(listener: () => void): void;
};

type Deps = { token: string | null; me: typeof me; request: typeof request; go(path: "/" | "/dashboard" | "/teams"): void };

type Outcome = { view: OpenView; failure?: OpenFailure };

/** What an answer to the link's opening leads to; null when it opened. Only the route's "no longer valid" reads as an expired link. */
function outcomeOf(answer: ApiResult<unknown>): Outcome | null {
  if (answer.kind === "ok") return null;
  if (answer.kind !== "refused" || answer.status >= 500) return { view: "failed" };
  const known = answer.status === 403 ? answer.error : null;
  if (known === LINK_NOT_VALID) return { view: "expired" };
  if (known === DASHBOARD_ADMINS_ONLY) return { view: "adminsOnly" };
  if (known === CROSS_SITE) return { view: "failed", failure: { kind: "wrongAddress" } };
  return { view: "failed", failure: { kind: "refused", error: answer.error } };
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
    failure: UNREACHABLE,
    noAccounts: false,
    busy: false,
    open,
    onChange: (listener) => void listeners.push(listener),
  };

  function tell(): void {
    for (const listener of listeners) listener();
  }

  /** Shows `view`, and for `failed` why; any press has been answered. */
  function show(view: OpenView, failure = UNREACHABLE): void {
    state.view = view;
    state.failure = failure;
    state.busy = false;
    tell();
  }

  /** Posts the token; on success the page navigates away, so a pressed button stays busy. */
  async function post(link: string): Promise<void> {
    const outcome = outcomeOf(await deps.request("POST", OPEN_PATH, { token: link }));
    if (outcome === null) deps.go(state.noAccounts ? "/" : "/dashboard");
    else show(outcome.view, outcome.failure);
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
