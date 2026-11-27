import { isToken, tokenOf } from "../site/fragment-token.js";
import type { request } from "../site/http.js";
import type { me, signOut } from "../site/session.js";
import { acceptedPath, failureOf, isPreview, viewAfterRefusal, type Failure, type InviteView, type Preview } from "./answers.js";

/** What `/invite` shows and does with an admin's or viewer's invitation. Nothing is accepted until `accept()`. */

/** Where the invitation's token waits in the tab while the person signs in with GitHub. */
export const INVITE_KEY = "teamusage.invite";

export type { InviteView, Preview } from "./answers.js";

const PREVIEW_PATH = "/api/invites/preview";
const ACCEPT_PATH = "/api/invites/accept";

/** The views after which the token is of no more use in this tab: the invitation is gone, or cannot serve this account. */
const FORGETS: readonly InviteView[] = ["notValid", "hasRole"];

/** The token of `#<64 hex>`, which is then kept in `storage`; otherwise the token `storage` holds; null when neither. */
export function takeToken(hash: string, storage: Pick<Storage, "getItem" | "setItem">): string | null {
  const fromAddress = tokenOf(hash);
  if (fromAddress !== null) {
    storage.setItem(INVITE_KEY, fromAddress);
    return fromAddress;
  }
  const kept = storage.getItem(INVITE_KEY);
  return kept !== null && isToken(kept) ? kept : null;
}

/**
 * `loading`: the invitation and the session are being read; `view` is drawn once it is false.
 * `busy`: a press of Accept or "Use another account" is being answered.
 * `switchAccount`: the person signed out to use another account, so the sign-in says how.
 * `signOutFailed`: the last "Use another account" did not end the session.
 * `failure`: why the view is `failed`; null in any other view.
 */
export type Inviter = {
  view: InviteView;
  preview: Preview | null;
  login: string | null;
  loading: boolean;
  busy: boolean;
  switchAccount: boolean;
  signOutFailed: boolean;
  failure: Failure | null;
  accept(): Promise<void>;
  useAnotherAccount(): Promise<void>;
  retry(): Promise<void>;
};

type Deps = {
  token: string | null;
  storage: Pick<Storage, "removeItem">;
  me: typeof me;
  request: typeof request;
  signOut: typeof signOut;
  go(path: string): void;
  onChange(): void;
};

/** Reads the invitation and the session, then waits for a press. `onChange` is never called before this returns. */
export function inviter(deps: Deps): Inviter {
  const { token } = deps;
  const forget = () => deps.storage.removeItem(INVITE_KEY);
  const state: Inviter = {
    view: "none",
    preview: null,
    login: null,
    loading: token !== null,
    busy: false,
    switchAccount: false,
    signOutFailed: false,
    failure: null,
    accept,
    useAnotherAccount,
    retry,
  };

  /** Shows `view` with every read and press answered, and forgets the token after a view that has no more use for it. */
  function show(view: InviteView): void {
    state.view = view;
    if (view !== "failed") state.failure = null;
    state.loading = false;
    state.busy = false;
    if (FORGETS.includes(view)) forget();
    deps.onChange();
  }

  /** Shows `failed`, saying why. */
  function fail(failure: Failure): void {
    state.failure = failure;
    show("failed");
  }

  /** The preview first, so a link that no longer works never asks who is signed in; then the session. */
  async function read(link: string): Promise<void> {
    const answer = await deps.request<unknown>("POST", PREVIEW_PATH, { token: link });
    if (answer.kind === "refused" && answer.status === 404) return show("notValid");
    if (answer.kind !== "ok" || !isPreview(answer.value)) return fail(failureOf(answer));
    state.preview = answer.value;
    const session = await deps.me();
    if (session.kind === "failed") return fail({ kind: "unreachable" });
    state.login = session.kind === "me" && session.me.kind === "user" ? session.me.login : null;
    show(state.login === null ? "signIn" : "accept");
  }

  /** "Try again": reads the invitation and the session again; a new press is still needed to accept. */
  async function retry(): Promise<void> {
    if (token === null || state.loading || state.view !== "failed") return;
    state.loading = true;
    deps.onChange();
    return read(token);
  }

  /** "Accept as @login": one request at a time. On success the token is forgotten and the browser moves on, so the page stays busy. */
  async function accept(): Promise<void> {
    if (token === null || state.busy || state.view !== "accept") return;
    state.busy = true;
    state.signOutFailed = false;
    deps.onChange();
    const answer = await deps.request<unknown>("POST", ACCEPT_PATH, { token });
    if (answer.kind === "ok") {
      forget();
      return deps.go(acceptedPath(answer.value));
    }
    if (answer.kind === "unauthorized") state.login = null;
    const view = viewAfterRefusal(answer);
    if (view === "failed") fail(failureOf(answer));
    else show(view);
  }

  /** Ends the GitHub session so another account can sign in; if it may still be there, the person stays on `accept`. */
  async function useAnotherAccount(): Promise<void> {
    if (state.busy || state.view !== "accept") return;
    state.busy = true;
    state.signOutFailed = false;
    deps.onChange();
    if (await deps.signOut()) {
      state.login = null;
      state.switchAccount = true;
      return show("signIn");
    }
    state.busy = false;
    state.signOutFailed = true;
    deps.onChange();
  }

  if (token !== null) void read(token);
  return state;
}
