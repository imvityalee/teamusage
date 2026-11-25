import { afterEach, expect, test, vi } from "vitest";
import { githubClient } from "./github.js";

const TOKEN = "gho_test_token";
const SECRET = "secret-of-the-app";
const CONFIG = { clientId: "client-1", clientSecret: SECRET, publicUrl: "https://teamusage.example" };
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

type Sent = { url: string; method: string; headers: Record<string, string>; body: string; redirect: string; signal: AbortSignal };
type Answer = () => Response | Promise<Response>;

/** A fetch that records every request and answers the n-th one with `answers[n]`. */
function scripted(...answers: Answer[]) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: String(init.body ?? ""),
      redirect: String(init.redirect),
      signal: init.signal!,
    });
    const answer = answers[sent.length - 1];
    if (!answer) throw new Error("unexpected request");
    return answer();
  }) as typeof fetch;
  return { fetchFn, sent };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const text = (body: string, status = 200) => () => new Response(body, { status });
/** A redirect whose body would be a good answer, so that only the status can refuse it. */
const redirect = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 302, headers: { Location: "https://evil.example/" } });
const tokenOk = json({ access_token: TOKEN, token_type: "bearer", scope: "", refresh_token: "ghr_refresh", expires_in: 28800 });
const userOk = json({ id: 1, login: "ann", name: "Ann" });
const fetchUser = (fetchFn: typeof fetch) => githubClient(CONFIG, fetchFn).fetchUser({ code: "the-code", verifier: "the-verifier" });
const never = () => new Promise<Response>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

test("the authorize URL asks for no scope and carries the state and the S256 challenge", () => {
  const url = new URL(githubClient(CONFIG, scripted().fetchFn).authorizeUrl({ state: "st", challenge: "ch" }));
  expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "client-1",
    redirect_uri: "https://teamusage.example/auth/github/callback",
    state: "st",
    code_challenge: "ch",
    code_challenge_method: "S256",
  });
});

test("a good code gives the user; the secret goes only to the token URL and the token only in the user request's Authorization", async () => {
  const { fetchFn, sent } = scripted(tokenOk, userOk);
  expect(await fetchUser(fetchFn)).toEqual({ id: 1, login: "ann" });
  expect(sent.map((s) => [s.method, s.url, s.redirect])).toEqual([
    ["POST", TOKEN_URL, "manual"],
    ["GET", USER_URL, "manual"],
  ]);
  expect(JSON.parse(sent[0]!.body)).toEqual({
    client_id: "client-1",
    client_secret: SECRET,
    code: "the-code",
    redirect_uri: "https://teamusage.example/auth/github/callback",
    code_verifier: "the-verifier",
  });
  expect(sent[0]!.headers).toMatchObject({ Accept: "application/json", "Content-Type": "application/json" });
  expect(sent[1]!.headers).toEqual({
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "teamusage",
  });
  const { signal: _s0, ...tokenRequest } = sent[0]!;
  const { signal: _s1, ...userRequest } = sent[1]!;
  const { Authorization: _a, ...userHeaders } = userRequest.headers;
  expect(JSON.stringify(tokenRequest)).not.toContain(TOKEN);
  expect(JSON.stringify({ ...userRequest, headers: userHeaders })).not.toContain(TOKEN);
  expect(JSON.stringify(userRequest)).not.toContain(SECRET);
});

test.each<[string, Answer[]]>([
  ["the token answer is an error", [json({ error: "bad_verification_code", error_description: "The code is wrong." }), userOk]],
  ["the token answer is status 500", [json({ access_token: TOKEN }, 500), userOk]],
  ["the token answer is a redirect", [redirect({ access_token: TOKEN }), userOk]],
  ["the token answer is not JSON", [text("<html>oops</html>"), userOk]],
  ["the token answer has no access_token", [json({ token_type: "bearer" }), userOk]],
  ["the token answer's access_token is not a string", [json({ access_token: 42 }), userOk]],
  ["the token answer's access_token is empty", [json({ access_token: "" }), userOk]],
  ["the user answer is status 401", [tokenOk, json({ id: 1, login: "ann" }, 401)]],
  ["the user answer is a redirect", [tokenOk, redirect({ id: 1, login: "ann" })]],
  ["the user answer is not JSON", [tokenOk, text(`not json ${TOKEN}`)]],
  ["the user answer has id \"1\"", [tokenOk, json({ id: "1", login: "ann" })]],
  ["the user answer has id 0", [tokenOk, json({ id: 0, login: "ann" })]],
  ["the user answer has id 1.5", [tokenOk, json({ id: 1.5, login: "ann" })]],
  ["the user answer has an id past the safe integers", [tokenOk, json({ id: 2 ** 53, login: "ann" })]],
  ["the user answer has a login with a space", [tokenOk, json({ id: 1, login: "ann b" })]],
  ["the user answer has a login of 101 characters", [tokenOk, json({ id: 1, login: "a".repeat(101) })]],
  ["the user answer is an array", [tokenOk, json([{ id: 1, login: "ann" }])]],
  ["fetch rejects", [() => Promise.reject(new Error(`network down ${TOKEN}`))]],
  ["fetch rejects with a timeout", [() => Promise.reject(new DOMException("timed out", "TimeoutError"))]],
  ["fetch rejects on the user request", [tokenOk, () => Promise.reject(new TypeError("fetch failed"))]],
  ["reading the user body fails", [tokenOk, () => ({ status: 200, json: () => Promise.reject(new SyntaxError(TOKEN)) }) as unknown as Response]],
  ["reading the user body throws", [tokenOk, () => ({ status: 200, json: () => { throw new Error(TOKEN); } }) as unknown as Response]],
])("null when %s, and the token is in nothing it gives", async (_name, answers) => {
  const result = fetchUser(scripted(...answers).fetchFn);
  await expect(result).resolves.toBeNull();
});

test("null when fetch throws before it returns a promise", async () => {
  const fetchFn = (() => {
    throw new Error(`sync ${TOKEN}`);
  }) as unknown as typeof fetch;
  await expect(fetchUser(fetchFn)).resolves.toBeNull();
});

test.each<[string, Answer[]]>([
  ["the token request", [never]],
  ["the user request", [tokenOk, never]],
  ["reading the user body", [tokenOk, () => ({ status: 200, json: never }) as unknown as Response]],
])("null when %s takes ten seconds, and that request is aborted", async (_name, answers) => {
  vi.useFakeTimers();
  const { fetchFn, sent } = scripted(...answers);
  let settled = false;
  const result = fetchUser(fetchFn).then((user) => {
    settled = true;
    return user;
  });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(settled).toBe(false);
  const hung = sent.at(-1)!;
  expect(hung.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeNull();
  expect(hung.signal.aborted).toBe(true);
});

test("each request has its own ten seconds", async () => {
  vi.useFakeTimers();
  const late = (answer: Answer) => () => new Promise<Response>((resolve) => setTimeout(() => resolve(answer()), 9_000));
  const result = fetchUser(scripted(late(tokenOk), late(userOk)).fetchFn);
  await vi.advanceTimersByTimeAsync(18_000);
  expect(await result).toEqual({ id: 1, login: "ann" });
});
