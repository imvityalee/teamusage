import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getSetting } from "./db.js";
import { NewerSchemaError } from "./migrate.js";
import { DEFAULT_WEB_ROOT, buildServer, openFailureMessage, parseServerConfig, startupLines, type ServerConfig } from "./main.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tu-main-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  port: 8787,
  host: "127.0.0.1",
  dataDir: join(tmp(), "data"),
  inviteCodeFromEnv: undefined,
  demo: false,
  trustedProxies: 0,
  ...over,
});
const conn = (address = "1.2.3.4") => ({ incoming: { socket: { remoteAddress: address } } });

describe("parseServerConfig", () => {
  test("defaults", () => {
    expect(parseServerConfig({}, [])).toEqual({
      port: 8787,
      host: "0.0.0.0",
      dataDir: "/data",
      inviteCodeFromEnv: undefined,
      demo: false,
      trustedProxies: 0,
    });
  });

  test("reads the environment and flags", () => {
    const c = parseServerConfig(
      { PORT: "9000", TEAMUSAGE_DATA_DIR: "/x", TEAMUSAGE_INVITE_CODE: "abcdefghij123456", TEAMUSAGE_TRUSTED_PROXIES: "2", TEAMUSAGE_HOST: "127.0.0.1" },
      [],
    );
    expect(c).toMatchObject({ port: 9000, dataDir: "/x", inviteCodeFromEnv: "abcdefghij123456", trustedProxies: 2, host: "127.0.0.1" });
    expect(parseServerConfig({ TEAMUSAGE_DEMO: "1" }, []).demo).toBe(true);
    expect(parseServerConfig({}, ["--demo"]).demo).toBe(true);
    expect(parseServerConfig({ TEAMUSAGE_DEMO: "0" }, []).demo).toBe(false);
    expect(parseServerConfig({ TEAMUSAGE_INVITE_CODE: "" }, []).inviteCodeFromEnv).toBeUndefined();
  });

  test("rejects a weak or malformed operator invite code without echoing it", () => {
    const msg = "TEAMUSAGE_INVITE_CODE must be 16 to 128 characters with no spaces";
    for (const [name, v] of [
      ["too short", "s".repeat(15)],
      ["too long", "l".repeat(129)],
      ["space", "has a space-0123456789"],
      ["tab", "tab\tinside-0123456789"],
      ["newline", "line\nbreak-0123456789"],
      ["control", "ctl\x01char-0123456789"],
    ] as const) {
      let err: Error | undefined;
      try {
        parseServerConfig({ TEAMUSAGE_INVITE_CODE: v }, []);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message, name).toBe(msg);
    }
    expect(parseServerConfig({ TEAMUSAGE_INVITE_CODE: "x".repeat(16) }, []).inviteCodeFromEnv).toBe("x".repeat(16));
    expect(parseServerConfig({ TEAMUSAGE_INVITE_CODE: "x".repeat(128) }, []).inviteCodeFromEnv).toBe("x".repeat(128));
  });

  test("rejects invalid PORT and TEAMUSAGE_TRUSTED_PROXIES with a fixed message", () => {
    for (const PORT of ["0", "65536", "-1", "80.5", "abc", " 80", "1e3", "0x50"]) {
      expect(() => parseServerConfig({ PORT }, []), PORT).toThrow("PORT must be an integer from 1 to 65535");
    }
    for (const v of ["-1", "11", "1.5", "x", "2 "]) {
      expect(() => parseServerConfig({ TEAMUSAGE_TRUSTED_PROXIES: v }, []), v).toThrow(
        "TEAMUSAGE_TRUSTED_PROXIES must be an integer from 0 to 10",
      );
    }
    expect(parseServerConfig({ PORT: "65535", TEAMUSAGE_TRUSTED_PROXIES: "10" }, [])).toMatchObject({ port: 65535, trustedProxies: 10 });
    expect(() => parseServerConfig({ PORT: "bad-secret" }, [])).toThrow(/^PORT must be an integer from 1 to 65535$/);
  });
});

describe("DEFAULT_WEB_ROOT", () => {
  test("is packages/server/web/dist", () => {
    expect(DEFAULT_WEB_ROOT.split(sep).slice(-4)).toEqual(["packages", "server", "web", "dist"]);
  });
});

describe("buildServer", () => {
  test("creates the data dir privately and a database that is not world-readable", () => {
    const c = cfg();
    const s = buildServer(c);
    try {
      expect(statSync(c.dataDir).mode & 0o077).toBe(0);
      expect(statSync(join(c.dataDir, "teamusage.sqlite")).mode & 0o077).toBe(0);
    } finally {
      s.close();
    }
  });

  test("generates an invite code once and persists it; env code is not flagged as generated", async () => {
    const c = cfg();
    const a = buildServer(c);
    const code = a.inviteCode();
    expect(a.inviteGenerated).toBe(true);
    expect(code).toMatch(/^[a-f0-9]{24}$/);
    a.close();
    const b = buildServer(c);
    expect(b.inviteCode()).toBe(code);
    expect(b.inviteGenerated).toBe(false);
    b.close();
    const e = buildServer(cfg({ inviteCodeFromEnv: "from-env-code-0123456789" }));
    expect(e.inviteCode()).toBe("from-env-code-0123456789");
    expect(e.inviteGenerated).toBe(false);
    e.close();
  });

  test("the invite code is logged on the start that generates it and never again", () => {
    const c = cfg();
    const first = buildServer(c);
    const code = first.inviteCode();
    const log1 = startupLines(c, first, 8787).join("\n");
    first.close();
    expect(log1).toContain(code);
    const second = buildServer(c);
    const log2 = startupLines(c, second, 8787);
    second.close();
    expect(log2.join("\n")).not.toContain(code);
    expect(log2.join("\n")).toContain("show-invite");
    expect(log2).toHaveLength(2);
  });

  test("env-pinned and demo starts log no code", () => {
    const pinnedCfg = cfg({ inviteCodeFromEnv: "pinned-code-0123456789" });
    const p = buildServer(pinnedCfg);
    const pLog = startupLines(pinnedCfg, p, 1).join("\n");
    p.close();
    expect(pLog).not.toContain("pinned-code-0123456789");
    expect(pLog).toContain("environment");
    const demoCfg = cfg({ demo: true });
    const d = buildServer(demoCfg);
    const dLog = startupLines(demoCfg, d, 1).join("\n");
    d.close();
    expect(dLog).toContain("nothing is saved");
    expect(dLog).not.toContain("invite code (shown");
  });

  test("records whether the invite code is pinned by the environment", () => {
    const c = cfg();
    const pinned = buildServer({ ...c, inviteCodeFromEnv: "pinned-code-0123456789" });
    expect(getSetting(pinned.db, "invite_pinned")).toBe("1");
    pinned.close();
    const free = buildServer(c);
    expect(getSetting(free.db, "invite_pinned")).toBe("0");
    free.close();
  });

  test("demo mode opens no database file and has no login", async () => {
    const c = cfg({ demo: true });
    const s = buildServer(c);
    try {
      expect(existsSync(c.dataDir)).toBe(false);
      expect(s.inviteGenerated).toBe(false);
      const res = await s.app.request("/api/stats?from=2026-08-21&to=2026-11-18", {}, conn());
      expect(res.status).toBe(200);
      expect(((await res.json()) as { members: unknown[] }).members).toHaveLength(6);
    } finally {
      s.close();
    }
  });

  test("security headers are on every response", async () => {
    const s = buildServer(cfg({ demo: true }));
    try {
      for (const path of ["/", "/api/health", "/api/nope", "/nope"]) {
        const res = await s.app.request(path, {}, conn());
        expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
        expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
        expect(res.headers.get("x-frame-options"), path).toBe("DENY");
        expect(res.headers.get("content-security-policy"), path).toBe(
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
      }
    } finally {
      s.close();
    }
  });

  test("API keeps working and throttles by socket address", async () => {
    const s = buildServer(cfg());
    try {
      const health = await s.app.request("/api/health", {}, conn());
      expect(health.status).toBe(200);
      const bad = () =>
        s.app.request("/api/login", { method: "POST", body: JSON.stringify({ inviteCode: "nope" }) }, conn("9.9.9.9"));
      for (let i = 0; i < 10; i++) expect((await bad()).status).toBe(403);
      expect((await bad()).status).toBe(429);
      const other = await s.app.request("/api/login", { method: "POST", body: JSON.stringify({ inviteCode: "nope" }) }, conn("8.8.8.8"));
      expect(other.status).toBe(403);
    } finally {
      s.close();
    }
  });

  test("trusted proxies take the client from X-Forwarded-For", async () => {
    const s = buildServer(cfg({ trustedProxies: 1 }));
    try {
      const attempt = (xff: string) =>
        s.app.request("/api/login", { method: "POST", body: JSON.stringify({ inviteCode: "nope" }), headers: { "x-forwarded-for": xff } }, conn("10.0.0.1"));
      for (let i = 0; i < 10; i++) await attempt(`spoof${i}, 5.5.5.5`);
      expect((await attempt("another, 5.5.5.5")).status).toBe(429);
      expect((await attempt("x, 6.6.6.6")).status).toBe(403);
    } finally {
      s.close();
    }
  });

  test("without a built dashboard GET / is a fixed page and the API still works", async () => {
    const s = buildServer(cfg({ demo: true }), { webRoot: join(tmp(), "missing") });
    try {
      const res = await s.app.request("/", {}, conn());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("dashboard is not built");
      expect((await s.app.request("/api/health", {}, conn())).status).toBe(200);
      expect((await s.app.request("/other", {}, conn())).status).toBe(404);
    } finally {
      s.close();
    }
  });

  test("serves web files, and never anything outside the directory", async () => {
    const root = tmp();
    const web = join(root, "dist");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(root, "secret.txt"), "TOP-SECRET");
    // A sibling whose name starts with the root's name: a prefix-only containment check would accept it.
    mkdirSync(join(root, "dist-evil"));
    writeFileSync(join(root, "dist-evil", "x.txt"), "SIBLING-SECRET");
    symlinkSync(join(root, "dist-evil", "x.txt"), join(web, "sibling.txt"));
    // A file whose real name holds a literal "%61": only a single decode of /%2561.txt reaches it.
    writeFileSync(join(web, "%61.txt"), "literal-percent-name");
    writeFileSync(join(web, ".hidden"), "DOTFILE");
    writeFileSync(join(web, "assets", "app.js.map"), "MAP");
    writeFileSync(join(web, "100%.txt"), "percent");
    symlinkSync(join(root, "secret.txt"), join(web, "link.txt"));
    const s = buildServer(cfg({ demo: true }), { webRoot: web });
    try {
      const idx = await s.app.request("/", {}, conn());
      expect(await idx.text()).toBe("<h1>hi</h1>");
      expect(idx.headers.get("content-type")).toContain("text/html");
      const js = await s.app.request("/assets/app.js", {}, conn());
      expect(js.headers.get("content-type")).toContain("javascript");
      expect(await js.text()).toBe("console.log(1)");
      for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt", "/link.txt", "/%00", "/assets/", "/assets", "/missing.js", "/%2e%2e%2f%2e%2e%2fetc/passwd",
        "/%252e%252e%252fsecret.txt", "/%252e%252e/secret.txt", "/assets/%252e%252e%252f%252e%252e%252fsecret.txt",
        "/..%2fdist-evil%2fx.txt", "/%2e%2e%2fdist-evil%2fx.txt", "/..%5cdist-evil%5cx.txt", "/../dist-evil/x.txt",
        "/sibling.txt", "/.hidden", "/assets/app.js.map", "/%2561.txt/..%252fx"]) {
        const res = await s.app.request(p, {}, conn());
        const body = await res.text();
        expect(res.status, p).toBe(404);
        expect(body, p).not.toMatch(/TOP-SECRET|SIBLING-SECRET|DOTFILE|^MAP$/);
      }
      expect(idx.headers.get("cache-control")).toBe("no-cache");
      expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      const pct = await s.app.request("/100%25.txt", {}, conn());
      expect(await pct.text()).toBe("percent");
      // Decoded exactly once: %2561 is the literal name "%61.txt", not "a.txt" and not a traversal.
      const lit = await s.app.request("/%2561.txt", {}, conn());
      expect(lit.status).toBe(200);
      expect(await lit.text()).toBe("literal-percent-name");
      // API paths are never answered from the web directory.
      mkdirSync(join(web, "api"));
      writeFileSync(join(web, "api", "health"), "static");
      expect(((await (await s.app.request("/api/health", {}, conn())).json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      s.close();
    }
  });
});

test("a restart keeps the one team", () => {
  const c = cfg();
  const first = buildServer(c);
  first.close();
  const second = buildServer(c);
  expect(second.db.prepare("select count(*) as n from teams").get()).toEqual({ n: 1 });
  second.close();
});

test("a newer database gets its own start message", () => {
  expect(openFailureMessage(new NewerSchemaError())).toBe("teamusage: this database was written by a newer teamusage; upgrade the server");
  expect(openFailureMessage(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("teamusage: could not open the data directory or database (EACCES)");
});
