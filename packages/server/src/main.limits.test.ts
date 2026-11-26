import { afterEach, expect, test, vi } from "vitest";
import { goodReg, MID2, record } from "./app.fixture.js";
import { hostedTeam, signIn } from "./hosted.fixture.js";
import { conn, github, hosted, PUBLIC_URL, roomy, serverConfig, tempDataDir } from "./main.fixture.js";
import { buildServer, type BuiltServer } from "./main.js";
import type { DiskSpace } from "./storage-guard.js";

const full = () => ({ free: 10, total: 100 });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Keeps the disk guard's lines off the test output; returns the spy that received them. */
const captureErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

const send = (s: BuiltServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  s.app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }, conn);
const register = (s: BuiltServer, body: unknown) => send(s, "/api/register", body);
const upload = (s: BuiltServer, token: string, records: unknown[]) => send(s, "/api/usage", { records }, { Authorization: `Bearer ${token}` });
const createTeamAs = (s: BuiltServer, cookie: string, body: unknown) => send(s, "/api/teams", body, { Origin: PUBLIC_URL, Cookie: cookie });
const tokenOf = async (res: Response) => ((await res.json()) as { token: string }).token;

/** A hosted server with one team that ann created, her session cookie, the team's code and one registered machine's token. */
async function hostedMachine(opts: { measureDisk?: (dir: string) => DiskSpace }) {
  const config = hosted(tempDataDir());
  const s = buildServer(config, { github: github(), ...opts });
  const ann = await signIn(s.app, "code-ann");
  const created = await createTeamAs(s, ann, { name: "Acme", dashboardAccess: "code" });
  const { code } = (await created.json()) as { code: string };
  const token = await tokenOf(await register(s, goodReg({ inviteCode: code })));
  return { s, ann, code, token, dataDir: config.dataDir };
}

test("a hosted server lets a machine upload thirty times a minute", async () => {
  const { s, token } = await hostedMachine({ measureDisk: roomy });
  try {
    for (let i = 0; i < 30; i++) expect((await upload(s, token, [record({ model: `m${i}` })])).status).toBe(200);
    const res = await upload(s, token, [record({ model: "m30" })]);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too many uploads; try again in a minute", limit: "uploads" });
  } finally {
    s.close();
  }
});

test("a hosted server on a nearly full volume takes no new machine, row or team, and still updates rows", async () => {
  const errors = captureErrors();
  let space = roomy();
  const measured = new Set<string>();
  const { s, token, code, ann, dataDir } = await hostedMachine({ measureDisk: (dir) => (measured.add(dir), space) });
  try {
    expect((await upload(s, token, [record()])).status).toBe(200);
    space = full();
    expect((await register(s, goodReg({ inviteCode: code, email: "new@example.com", machineId: MID2 }))).status).toBe(507);
    expect((await upload(s, token, [record({ model: "new" })])).status).toBe(507);
    expect((await createTeamAs(s, ann, { name: "Second", dashboardAccess: "code" })).status).toBe(503);
    expect(await (await upload(s, token, [record({ input: 91, total: 100 })])).json()).toEqual({ stored: 1, kept: 0 });
    expect((await s.app.request("/api/health")).status).toBe(200);
    expect([...measured]).toEqual([dataDir]);
    expect(errors.mock.calls).toEqual([["teamusage: less than 15% of the data volume is free; requests that add rows are refused"]]);
  } finally {
    s.close();
  }
});

test("a self-hosted server limits none of this and never measures the disk", async () => {
  let measured = 0;
  const s = buildServer(serverConfig(), {
    measureDisk: () => {
      measured++;
      return full();
    },
  });
  try {
    const inviteCode = s.inviteCode!();
    const token = await tokenOf(await register(s, goodReg({ inviteCode })));
    for (let i = 0; i < 31; i++) expect((await upload(s, token, [record({ model: `m${i}` })])).status).toBe(200);
    expect((await register(s, goodReg({ inviteCode, email: "new@example.com", machineId: MID2 }))).status).toBe(200);
    expect(measured).toBe(0);
  } finally {
    s.close();
  }
});

test("a hosted server without a test's measurement measures its own data directory", async () => {
  const errors = captureErrors();
  const s = buildServer(hosted(tempDataDir()), { github: github() });
  try {
    const { code } = hostedTeam(s.db, { githubId: 1, login: "ann" }, "code");
    // The real volume may or may not be nearly full; either answer is right, a failure is not.
    expect([200, 507]).toContain((await register(s, goodReg({ inviteCode: code }))).status);
    expect(errors.mock.calls.flat().join("\n")).not.toContain("could not measure");
  } finally {
    s.close();
  }
});
