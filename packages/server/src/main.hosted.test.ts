import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { goodReg } from "./app.fixture.js";
import type { ServerConfig } from "./config.js";
import { getSetting, openDb } from "./db.js";
import { createHostedTeam } from "./hosted-teams.js";
import { cookieOf, fakeGithub, KEY, signIn } from "./hosted.fixture.js";
import { buildServer, startupLines } from "./main.js";
import { HostedDatabaseError } from "./open-failure.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tu-hosted-"));
  dirs.push(d);
  return join(d, "data");
};

const PUBLIC_URL = "https://usage.example.org";
const SECRET = "github-secret-value-0123";
const selfHosted = (dir: string): ServerConfig => ({
  port: 8787,
  host: "127.0.0.1",
  dataDir: dir,
  inviteCodeFromEnv: undefined,
  demo: false,
  trustedProxies: 0,
  mode: "self-hosted",
  hosted: undefined,
});
const hosted = (dir: string): ServerConfig => ({
  ...selfHosted(dir),
  mode: "hosted",
  hosted: { publicUrl: PUBLIC_URL, githubClientId: "github-client-id", githubClientSecret: SECRET, codeKey: KEY, maxTeams: 200 },
});
const github = () => fakeGithub({ "code-ann": { id: 1, login: "ann" } });
const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
const conn = from("1.2.3.4");
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
  const first = buildServer(hosted(dir), { github: github() });
  try {
    const res = await first.app.request("/api/teams", {
      method: "POST",
      body: JSON.stringify({ name: "Acme", dashboardAccess: "code" }),
      headers: { "Content-Type": "application/json", Origin: PUBLIC_URL, Cookie: await signIn(first.app, "code-ann") },
    }, conn);
    expect(res.status).toBe(201);
    return ((await res.json()) as { code: string }).code;
  } finally {
    first.close();
  }
}

describe("a hosted buildServer", () => {
  test("creates no team and no invite code, and has no invite code to give", () => {
    const config = hosted(dataDir());
    const s = buildServer(config, { github: github() });
    try {
      startupLines(config, s, 8787);
      expect(s.inviteCode).toBeUndefined();
      expect(s.inviteGenerated).toBe(false);
      expect(count(s.db, "teams")).toEqual({ n: 0 });
      expect(getSetting(s.db, "invite_code")).toBeUndefined();
    } finally {
      s.close();
    }
  });

  test("forwards /auth to the app, with the security headers every response carries", async () => {
    const s = buildServer(hosted(dataDir()), { github: github() });
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
    const s = buildServer(hosted(dataDir()), { github: github() });
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
    const s = buildServer(hosted(dataDir()));
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
    const dir = dataDir();
    const code = await hostedServerWithTeam(dir);
    const second = buildServer(hosted(dir), { github: github() });
    try {
      expect(count(second.db, "teams")).toEqual({ n: 1 });
      const reg = await second.app.request("/api/register", { method: "POST", body: JSON.stringify(goodReg({ inviteCode: code })) }, conn);
      expect(reg.status).toBe(200);
    } finally {
      second.close();
    }
  });

  test("logs exactly the listening line and where people sign in, with no secret and no code", () => {
    const config = hosted(dataDir());
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
    const s = buildServer({ ...hosted(dataDir()), ...over }, { github: github() });
    const { code } = createHostedTeam(s.db, { name: "Acme", dashboardAccess: "code", owner: { githubId: 1, login: "ann" }, codeKey: KEY, maxTeams: 200 });
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
    const s = buildServer(selfHosted(dataDir()));
    try {
      const res = await s.app.request("/auth/github/start", {}, conn);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      s.close();
    }
  });

  test("refuses a database that holds a hosted team, and changes nothing in it", async () => {
    const dir = dataDir();
    await hostedServerWithTeam(dir);
    const before = snapshot(dir);
    expect(before.teams).toHaveLength(1);
    expect(before.sessions).toHaveLength(1);
    expect(() => buildServer(selfHosted(dir))).toThrow(HostedDatabaseError);
    expect(snapshot(dir)).toEqual(before);
  });

  test("still starts on a hosted database that holds no team yet (the refusal looks for a hosted team)", () => {
    const dir = dataDir();
    buildServer(hosted(dir), { github: github() }).close();
    const s = buildServer(selfHosted(dir));
    try {
      expect(s.inviteCode?.()).toMatch(/^[a-f0-9]{24}$/);
      expect(count(s.db, "teams")).toEqual({ n: 1 });
    } finally {
      s.close();
    }
  });
});
