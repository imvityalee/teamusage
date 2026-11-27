import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { goodReg } from "./app.fixture.js";
import type { ServerConfig } from "./config.js";
import { openDb } from "./db.js";
import { HostedDatabaseError, SelfHostedDatabaseError } from "./db-mode.js";
import { cookieOf, hostedTeam, KEY, signIn } from "./hosted.fixture.js";
import { conn, from, github, hosted, PUBLIC_URL, roomy, SECRET, serverConfig, tempDataDir } from "./main.fixture.js";
import { buildServer, startupLines } from "./main.js";

const selfHosted = (dataDir: string): ServerConfig => serverConfig({ dataDir });
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const count = (db: ReturnType<typeof openDb>, table: string) => db.prepare(`select count(*) as n from ${table}`).get();

/** Every row of the tables a refused start must leave alone, read from a separate connection. */
function snapshot(dir: string) {
  const db = openDb(join(dir, "teamusage.sqlite"));
  try {
    const all = (table: string) => db.prepare(`select * from ${table} order by rowid`).all();
    return { teams: all("teams"), settings: all("settings"), sessions: all("sessions"), members: all("members") };
  } finally {
    db.close();
  }
}

/** Starts a hosted server on `dir`, signs ann in and creates a team; returns the team's code. */
async function hostedServerWithTeam(dir: string): Promise<string> {
  const first = buildServer(hosted(dir), { github: github(), measureDisk: roomy });
  try {
    const res = await first.app.request("/api/teams", {
      method: "POST",
      body: JSON.stringify({ name: "Acme", dashboardAccess: "members" }),
      headers: { "Content-Type": "application/json", Origin: PUBLIC_URL, Cookie: await signIn(first.app, "code-ann") },
    }, conn);
    expect(res.status).toBe(201);
    return ((await res.json()) as { code: string }).code;
  } finally {
    first.close();
  }
}

/** Starts a self-hosted server on `dir`, registers a machine and signs a browser in with the invite code. */
async function selfHostedServerInUse(dir: string): Promise<void> {
  const s = buildServer(selfHosted(dir));
  try {
    const send = (path: string, body: unknown) => s.app.request(path, { method: "POST", body: JSON.stringify(body) }, conn);
    const inviteCode = s.inviteCode!();
    expect((await send("/api/register", goodReg({ inviteCode }))).status).toBe(200);
    expect((await send("/api/login", { inviteCode })).status).toBe(204);
  } finally {
    s.close();
  }
}

describe("a hosted buildServer", () => {
  test("marks the database as a hosted server's, creates no team and no invite code, and has no invite code to give", () => {
    const s = buildServer(hosted(tempDataDir()), { github: github() });
    try {
      expect(s.inviteCode).toBeUndefined();
      expect(s.inviteGenerated).toBe(false);
      expect(count(s.db, "teams")).toEqual({ n: 0 });
      expect(s.db.prepare("select key, value from settings").all()).toEqual([{ key: "mode", value: "hosted" }]);
    } finally {
      s.close();
    }
  });

  test("forwards /auth to the app, with the security headers every response carries", async () => {
    const s = buildServer(hosted(tempDataDir()), { github: github() });
    try {
      const res = await s.app.request("/auth/github/start", {}, conn);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^https:\/\/github\.test\/authorize\?state=/);
      expect(cookieOf(res, "tu_oauth")).not.toBe("");
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
    } finally {
      s.close();
    }
  });

  test("answers /api/health, and /api/me without a session is 401", async () => {
    const s = buildServer(hosted(tempDataDir()), { github: github() });
    try {
      expect((await s.app.request("/api/health", {}, conn)).status).toBe(200);
      const me = await s.app.request("/api/me", {}, conn);
      expect(me.status).toBe(401);
      expect(await me.json()).toEqual({ error: "unauthorized" });
    } finally {
      s.close();
    }
  });

  test("without a fake, signs in with GitHub through the configured app and checks Origin against the public URL", async () => {
    const s = buildServer(hosted(tempDataDir()));
    try {
      const start = await s.app.request("/auth/github/start", {}, conn);
      const location = new URL(start.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(location.searchParams.get("client_id")).toBe("github-client-id");
      expect(location.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/auth/github/callback`);
      const logout = (origin: string) => s.app.request("/api/logout", { method: "POST", headers: { Origin: origin } }, conn);
      expect((await logout(PUBLIC_URL)).status).toBe(204);
      expect((await logout(`${PUBLIC_URL}/`)).status).toBe(403);
    } finally {
      s.close();
    }
  });

  test("a second start on the same directory keeps the team created through the first, and its code", async () => {
    const dir = tempDataDir();
    const code = await hostedServerWithTeam(dir);
    const second = buildServer(hosted(dir), { github: github(), measureDisk: roomy });
    try {
      expect(count(second.db, "teams")).toEqual({ n: 1 });
      const reg = await second.app.request("/api/register", { method: "POST", body: JSON.stringify(goodReg({ inviteCode: code })) }, conn);
      expect(reg.status).toBe(200);
    } finally {
      second.close();
    }
  });

  test("refuses a self-hosted server's database, and changes nothing in it", async () => {
    const dir = tempDataDir();
    await selfHostedServerInUse(dir);
    const before = snapshot(dir);
    expect([before.teams, before.members, before.sessions].map((rows) => rows.length)).toEqual([1, 1, 1]);
    expect(() => buildServer(hosted(dir), { github: github() })).toThrow(SelfHostedDatabaseError);
    expect(snapshot(dir)).toEqual(before);
  });

  test("logs exactly the listening line and where people sign in, with no secret and no code", () => {
    const config = hosted(tempDataDir());
    const s = buildServer(config, { github: github() });
    try {
      const lines = startupLines(config, s, 8787);
      expect(lines).toEqual(["teamusage listening on http://127.0.0.1:8787", `hosted mode: people sign in at ${PUBLIC_URL}/auth/github/start`]);
      for (const secret of [SECRET, KEY.toString("base64"), KEY.toString("hex")]) expect(lines.join("\n")).not.toContain(secret);
    } finally {
      s.close();
    }
  });
});

describe("a hosted buildServer counts wrong codes per address", () => {
  const WRONG = "0".repeat(24);
  /** A hosted server with one team; `register(code, address, headers)` sends a registration from that address. */
  function serverWithTeam(over: Partial<ServerConfig> = {}) {
    const s = buildServer({ ...hosted(tempDataDir()), ...over }, { github: github(), measureDisk: roomy });
    const { code } = hostedTeam(s.db, { githubId: 1, login: "ann" }, "members");
    const register = (inviteCode: string, address: string, headers: Record<string, string> = {}) =>
      s.app.request("/api/register", { method: "POST", body: JSON.stringify(goodReg({ inviteCode })), headers }, from(address));
    return { s, code, register };
  }

  test("by the socket address", async () => {
    const { s, code, register } = serverWithTeam();
    try {
      for (let i = 0; i < 10; i++) expect((await register(WRONG, "1.2.3.4")).status).toBe(403);
      expect((await register(WRONG, "1.2.3.4")).status).toBe(429);
      expect((await register(WRONG, "5.6.7.8")).status).toBe(403);
      expect((await register(code, "1.2.3.4")).status).toBe(200);
    } finally {
      s.close();
    }
  });

  test("by X-Forwarded-For behind trusted proxies", async () => {
    const { s, code, register } = serverWithTeam({ trustedProxies: 1 });
    try {
      const forwarded = (inviteCode: string, xff: string) => register(inviteCode, "10.0.0.1", { "x-forwarded-for": xff });
      for (let i = 0; i < 10; i++) expect((await forwarded(WRONG, `spoof${i}, 5.5.5.5`)).status).toBe(403);
      expect((await forwarded(WRONG, "another, 5.5.5.5")).status).toBe(429);
      expect((await forwarded(WRONG, "x, 6.6.6.6")).status).toBe(403);
      expect((await forwarded(code, "x, 5.5.5.5")).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe("a self-hosted buildServer", () => {
  test("answers 404 on /auth/github/start", async () => {
    const s = buildServer(selfHosted(tempDataDir()));
    try {
      const res = await s.app.request("/auth/github/start", {}, conn);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("refuses a hosted server's database that holds a team, and changes nothing in it", async () => {
    const dir = tempDataDir();
    await hostedServerWithTeam(dir);
    const before = snapshot(dir);
    expect(before.teams).toHaveLength(1);
    expect(before.sessions).toHaveLength(1);
    expect(() => buildServer(selfHosted(dir))).toThrow(HostedDatabaseError);
    expect(snapshot(dir)).toEqual(before);
  });

  test("refuses a hosted server's database that holds no team yet, and changes nothing in it", () => {
    const dir = tempDataDir();
    buildServer(hosted(dir), { github: github() }).close();
    const before = snapshot(dir);
    expect(before.teams).toEqual([]);
    expect(() => buildServer(selfHosted(dir))).toThrow(HostedDatabaseError);
    expect(snapshot(dir)).toEqual(before);
  });
});
