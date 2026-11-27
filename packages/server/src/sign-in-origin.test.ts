import type { Hono } from "hono";
import { afterEach, beforeEach, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import { serverConfig } from "./main.fixture.js";
import { buildServer, type BuiltServer } from "./main.js";

const CODE = "operator-code-0123456789";
const OWN = "http://10.0.0.5:8787";
const FOREIGN = "https://evil.example";
const SAME_HOST_OTHER_PORT = "http://10.0.0.5:9999";
const SAME_HOST_OTHER_SCHEME = "https://10.0.0.5:8787";

let server: BuiltServer;
let app: Hono;
beforeEach(() => {
  server = buildServer(serverConfig({ publicUrl: OWN, inviteCodeFromEnv: CODE }));
  app = server.app;
});
afterEach(() => server.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
const login = (code: string, headers: Record<string, string>) => post("/api/login", { inviteCode: code }, headers);
const open = (token: string, headers: Record<string, string>) => post("/api/dashboard-link/open", { token }, headers);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** A machine joined through the product's own route, and a fresh link of its member. */
async function memberLink(): Promise<{ machineToken: string; link: string }> {
  const joined = await post("/api/register", goodReg({ inviteCode: CODE }));
  const { token: machineToken } = (await joined.json()) as { token: string };
  const linked = await app.request("/api/dashboard-link", { method: "POST", headers: bearer(machineToken) });
  const { path } = (await linked.json()) as { path: string };
  return { machineToken, link: path.slice("/open#".length) };
}

test("with the address set, the code signs a browser in only from that address", async () => {
  expect((await login(CODE, {})).status).toBe(403);
  expect((await login(CODE, { Origin: FOREIGN })).status).toBe(403);
  const ok = await login(CODE, { Origin: OWN });
  expect(ok.status).toBe(204);
  expect(ok.headers.get("set-cookie")).toContain("tu_session=");
});

test.each([SAME_HOST_OTHER_PORT, SAME_HOST_OTHER_SCHEME])("the code is refused from %s, which differs from the address in one part only", async (origin) => {
  expect((await login(CODE, { Origin: origin })).status).toBe(403);
});

test("a refused origin sets no cookie, reads no code and counts no attempt", async () => {
  for (let i = 0; i < 12; i++) {
    const refused = await login("wrong-code-000000", { Origin: FOREIGN });
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await refused.json()).toEqual({ error: "cross-site request refused" });
  }
  expect((await login(CODE, { Origin: OWN })).status).toBe(204); // twelve refusals did not use up the ten attempts
});

test("a refused origin reads no body", async () => {
  const res = await app.request("/api/login", { method: "POST", body: "{not json", headers: { Origin: FOREIGN } });
  expect(await res.json()).toEqual({ error: "cross-site request refused" });
});

test("a member's link opens a browser only from the address, and a refused link is not used up", async () => {
  const { link } = await memberLink();
  const refusedHeaders: Record<string, string>[] = [{}, { Origin: FOREIGN }, { Origin: SAME_HOST_OTHER_PORT }, { Origin: SAME_HOST_OTHER_SCHEME }];
  for (const headers of refusedHeaders) {
    const refused = await open(link, headers);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "cross-site request refused" });
    expect(refused.headers.get("set-cookie")).toBeNull();
  }
  const ok = await open(link, { Origin: OWN });
  expect(ok.status).toBe(204);
  expect(ok.headers.get("set-cookie")).toContain("tu_session=");
});

test("a machine's token needs no Origin to register, upload or read statistics", async () => {
  const { machineToken } = await memberLink();
  const registered = await post("/api/register", goodReg({ inviteCode: CODE, name: "Bob", email: "bob@example.com", machineId: "c".repeat(32) }));
  expect(registered.status).toBe(200);
  const uploaded = await post("/api/usage", { records: [record()] }, bearer(machineToken));
  expect(uploaded.status).toBe(200);
  const stats = await app.request("/api/stats?from=2026-11-01&to=2026-11-10&member=me", { headers: bearer(machineToken) });
  expect(stats.status).toBe(200);
});

test("without the setting neither route needs an Origin", async () => {
  server.close();
  server = buildServer(serverConfig({ inviteCodeFromEnv: CODE }));
  app = server.app;
  expect((await login(CODE, {})).status).toBe(204);
  const { link } = await memberLink();
  expect((await open(link, {})).status).toBe(204);
});
