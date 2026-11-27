import { afterEach, expect, test, vi } from "vitest";
import { goodReg, MID2, record } from "./app.fixture.js";
import { hostedTeam, signIn } from "./hosted.fixture.js";
import { conn, github, hosted, PUBLIC_URL, roomy, serverConfig, tempDataDir } from "./main.fixture.js";
import { buildServer, type BuiltServer } from "./main.js";
import type { DiskSpace } from "./storage-guard.js";
import { forTeam } from "./team-data.js";

const full = () => ({ free: 10e9, total: 100e9 });
/** The clock of the servers here unless a test gives another: rows dated in 2026 are inside the 730 days a hosted team keeps. */
const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const clock = () => NOW;

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

/**
 * A hosted server at NOW unless `opts` gives another clock, with one team that ann created, her session cookie, the
 * team's code and one registered machine's token.
 */
async function hostedMachine(opts: { measureDisk?: (dir: string) => DiskSpace; now?: () => number }) {
  const config = hosted(tempDataDir());
  const s = buildServer(config, { github: github(), now: clock, ...opts });
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

test("a hosted server lets one member register ten machines", async () => {
  const { s, code } = await hostedMachine({ measureDisk: roomy });
  try {
    const machine = (n: number) => goodReg({ inviteCode: code, machineId: n.toString(16).padStart(32, "0") });
    // hostedMachine registered the member's first machine.
    for (let n = 2; n <= 10; n++) expect((await register(s, machine(n))).status).toBe(200);
    const res = await register(s, machine(11));
    expect([res.status, await res.json()]).toEqual([409, { error: "this member has reached the limit of 10 machines", limit: "machines" }]);
  } finally {
    s.close();
  }
});

test("a hosted server lets a team's machines send 60,000 upload records a minute", async () => {
  const { s, code, token } = await hostedMachine({ measureDisk: roomy });
  try {
    const second = await tokenOf(await register(s, goodReg({ inviteCode: code, machineId: MID2 })));
    const third = await tokenOf(await register(s, goodReg({ inviteCode: code, machineId: "c".repeat(32) })));
    const thousand = Array.from({ length: 1000 }, (_, i) => record({ model: `m${i}` }));
    for (let i = 0; i < 30; i++) for (const machine of [token, second]) expect((await upload(s, machine, thousand)).status).toBe(200);
    const res = await upload(s, third, [record()]);
    expect([res.status, await res.json()]).toEqual([429, { error: "this team is sending too much at once; try again in a minute", limit: "team-uploads" }]);
  } finally {
    s.close();
  }
});

test("a hosted server lets a team's statistics take 6,000 ms a minute", async () => {
  const { s, token } = await hostedMachine({ measureDisk: roomy });
  try {
    let reading = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (reading += 1000));
    const stats = () => s.app.request("/api/stats?from=2026-11-01&to=2026-11-10&member=me", { headers: { Authorization: `Bearer ${token}` } }, conn);
    for (let i = 0; i < 6; i++) expect((await stats()).status).toBe(200);
    const res = await stats();
    expect([res.status, await res.json()]).toMatchObject([429, { limit: "team-stats" }]);
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
    const team = await createTeamAs(s, ann, { name: "Second", dashboardAccess: "code" });
    expect([team.status, await team.json()]).toEqual([503, { error: "sign-ups are paused" }]);
    expect(await (await upload(s, token, [record({ input: 91, total: 100 })])).json()).toEqual({ stored: 1, kept: 0 });
    expect((await s.app.request("/api/health")).status).toBe(200);
    expect([...measured]).toEqual([dataDir]);
    expect(errors.mock.calls).toEqual([["teamusage: less than 15% of the data volume is free; requests that add rows are refused"]]);
  } finally {
    s.close();
  }
});

/** Stores `count` rows of a machine over HTTP in uploads of 1,000: distinct models, dates spread over 2026-01 to 2026-10. */
async function storeThousands(s: BuiltServer, token: string, count: number, tag: string) {
  for (let from = 0; from < count; from += 1000) {
    const batch = Array.from({ length: Math.min(1000, count - from) }, (_, i) =>
      record({ date: `2026-${String((from + i) % 10 + 1).padStart(2, "0")}-15`, model: `${tag}${from + i}` }),
    );
    expect((await upload(s, token, batch)).status).toBe(200);
  }
}

test("a hosted server on a nearly full volume accepts rows again once a machine's rows are removed", async () => {
  const errors = captureErrors();
  let space = roomy();
  const { s, code, token } = await hostedMachine({ measureDisk: () => space });
  try {
    const second = await tokenOf(await register(s, goodReg({ inviteCode: code, machineId: MID2 })));
    await storeThousands(s, token, 3000, "a");
    await storeThousands(s, second, 3000, "b");
    space = { free: 400_000, total: 4_000_000 };
    const next = [record({ date: "2026-05-15", model: "new" })];
    expect((await upload(s, token, next)).status).toBe(507);
    const { id: teamId } = s.db.prepare("select id from teams").get() as { id: number };
    expect(forTeam(s.db, teamId).removeMachine(MID2)).toBe(true);
    expect((await upload(s, token, next)).status).toBe(200);
    expect(errors.mock.calls).toEqual([
      ["teamusage: less than 15% of the data volume is free; requests that add rows are refused"],
      ["teamusage: the data volume has room again; requests that add rows are accepted"],
    ]);
  } finally {
    s.close();
  }
});

test("a hosted server keeps 730 days by the clock it is given", async () => {
  const answerAt = async (now: number) => {
    const { s, token } = await hostedMachine({ measureDisk: roomy, now: () => now });
    try {
      return await (await upload(s, token, [record({ date: "2026-11-01" })])).json();
    } finally {
      s.close();
    }
  };
  expect(await answerAt(NOW)).toEqual({ stored: 1, kept: 0 });
  expect(await answerAt(Date.parse("2028-11-26T12:00:00.000Z"))).toEqual({ stored: 0, kept: 1 });
});

test("a self-hosted server drops nothing, however old", async () => {
  const s = buildServer(serverConfig(), { now: clock });
  try {
    const token = await tokenOf(await register(s, goodReg({ inviteCode: s.inviteCode!() })));
    expect(await (await upload(s, token, [record({ date: "2024-01-02" })])).json()).toEqual({ stored: 1, kept: 0 });
    expect(await (await upload(s, token, [record({ date: "2026-11-25" })])).json()).toEqual({ stored: 1, kept: 0 });
    expect(s.db.prepare("select date from usage order by date").pluck().all()).toEqual(["2024-01-02", "2026-11-25"]);
  } finally {
    s.close();
  }
});

test("a self-hosted server reads the clock it is given", async () => {
  const s = buildServer(serverConfig(), { now: () => Date.parse("2025-01-01T12:00:00.000Z") });
  try {
    const token = await tokenOf(await register(s, goodReg({ inviteCode: s.inviteCode!() })));
    // 2026-11-25 is beyond the "tomorrow" of a server whose clock is on 2025-01-01.
    expect((await upload(s, token, [record({ date: "2026-11-25" })])).status).toBe(400);
  } finally {
    s.close();
  }
});

test("a self-hosted server limits none of this and never measures the disk", async () => {
  let measured = 0;
  const s = buildServer(serverConfig(), {
    now: clock,
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

test("a hosted server without a test's measurement measures the real volume, and a registration never fails with 500", async () => {
  const errors = captureErrors();
  const s = buildServer(hosted(tempDataDir()), { github: github(), now: clock });
  try {
    const { code } = hostedTeam(s.db, { githubId: 1, login: "ann" }, "code");
    // The real volume may or may not be nearly full; either answer is right, a failure is not.
    expect([200, 507]).toContain((await register(s, goodReg({ inviteCode: code }))).status);
    expect(errors.mock.calls.flat().join("\n")).not.toContain("could not measure");
  } finally {
    s.close();
  }
});
