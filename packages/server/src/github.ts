import { isObject } from "./http.js";

export type GithubUser = { id: number; login: string };
export interface GithubClient {
  /** Where the browser goes to sign in. Asks for no scope. */
  authorizeUrl(a: { state: string; challenge: string }): string;
  /** The user behind a callback code, or null when GitHub refuses, fails, is slow or answers something else. */
  fetchUser(a: { code: string; verifier: string }): Promise<GithubUser | null>;
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
/** How long one call to GitHub, reading its body included, may take. */
const CALL_LIMIT_MS = 10_000;
const LOGIN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Makes one request and reads its 200 JSON answer with `read`; null for any other status (a redirect included,
 * since none is followed), for a body that is not JSON, for anything thrown, and when the limit passes first.
 * Never throws; the request is aborted once the call is over.
 */
async function call<T>(fetchFn: typeof fetch, url: string, init: RequestInit, read: (body: unknown) => T | null): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CALL_LIMIT_MS);
  });
  const answered = (async () => {
    const res = await fetchFn(url, { ...init, redirect: "manual", signal: controller.signal });
    return res.status === 200 ? read(await res.json()) : null;
  })().catch(() => null);
  try {
    return await Promise.race([answered, expired]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The access token of a token answer. A `refresh_token` or `expires_in` beside it is ignored. */
const accessToken = (body: unknown): string | null =>
  isObject(body) && typeof body.access_token === "string" && body.access_token !== "" ? body.access_token : null;

function githubUser(body: unknown): GithubUser | null {
  if (!isObject(body)) return null;
  const { id, login } = body;
  const validId = typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  return validId && typeof login === "string" && LOGIN.test(login) ? { id, login } : null;
}

export function githubClient(c: { clientId: string; clientSecret: string; publicUrl: string }, fetchFn: typeof fetch = fetch): GithubClient {
  const redirectUri = `${c.publicUrl}/auth/github/callback`;
  return {
    authorizeUrl({ state, challenge }) {
      const query = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return `${AUTHORIZE_URL}?${query}`;
    },
    async fetchUser({ code, verifier }) {
      // The token lives only here: it is sent once, to GitHub's user endpoint, and never stored or returned.
      const token = await call(fetchFn, TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "teamusage" },
        body: JSON.stringify({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      }, accessToken);
      if (token === null) return null;
      return call(fetchFn, USER_URL, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "teamusage" },
      }, githubUser);
    },
  };
}
