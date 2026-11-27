import { mkdirSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { getSetting } from "./db.js";
import { serverConfig, tempDir } from "./main.fixture.js";
import { DEFAULT_WEB_ROOT, buildServer, startupLines } from "./main.js";
const conn = (address = "1.2.3.4") => ({ incoming: { socket: { remoteAddress: address } } });

describe("DEFAULT_WEB_ROOT", () => {
  test("is packages/server/web/dist", () => {
    expect(DEFAULT_WEB_ROOT.split(sep).slice(-4)).toEqual(["packages", "server", "web", "dist"]);
  });
});

describe("buildServer", () => {
  test("creates the data dir privately and a database that is not world-readable", () => {
    const c = serverConfig();
    const s = buildServer(c);
    try {
      expect(statSync(c.dataDir).mode & 0o077).toBe(0);
      expect(statSync(join(c.dataDir, "teamusage.sqlite")).mode & 0o077).toBe(0);
    } finally {
      s.close();
    }
  });

  test("generates an invite code once and persists it; env code is not flagged as generated", async () => {
    const c = serverConfig();
    const a = buildServer(c);
    const code = a.inviteCode!();
    expect(a.inviteGenerated).toBe(true);
    expect(code).toMatch(/^[a-f0-9]{24}$/);
    a.close();
    const b = buildServer(c);
    expect(b.inviteCode!()).toBe(code);
    expect(b.inviteGenerated).toBe(false);
    b.close();
    const e = buildServer(serverConfig({ inviteCodeFromEnv: "from-env-code-0123456789" }));
    expect(e.inviteCode!()).toBe("from-env-code-0123456789");
    expect(e.inviteGenerated).toBe(false);
    e.close();
  });

  test("the invite code is logged on the start that generates it and never again", () => {
    const c = serverConfig();
    const first = buildServer(c);
    const code = first.inviteCode!();
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
    const pinnedCfg = serverConfig({ inviteCodeFromEnv: "pinned-code-0123456789" });
    const p = buildServer(pinnedCfg);
    const pLog = startupLines(pinnedCfg, p, 1).join("\n");
    p.close();
    expect(pLog).not.toContain("pinned-code-0123456789");
    expect(pLog).toContain("environment");
    const demoCfg = serverConfig({ demo: true });
    const d = buildServer(demoCfg);
    const dLog = startupLines(demoCfg, d, 1).join("\n");
    d.close();
    expect(dLog).toContain("nothing is saved");
    expect(dLog).not.toContain("invite code (shown");
  });

  test("a start that knows its address says where sign-in is accepted from; one that does not says nothing of it", () => {
    const known = serverConfig({ publicUrl: "http://10.0.0.5:8787" });
    const withAddress = buildServer(known);
    const lines = startupLines(known, withAddress, 8787);
    withAddress.close();
    expect(lines).toContain("sign-in is accepted only from pages at http://10.0.0.5:8787");
    const plain = serverConfig();
    const without = buildServer(plain);
    const plainLines = startupLines(plain, without, 8787);
    without.close();
    expect(plainLines.join("\n")).not.toContain("sign-in is accepted");
  });

  test("records whether the invite code is pinned by the environment", () => {
    const c = serverConfig();
    const pinned = buildServer({ ...c, inviteCodeFromEnv: "pinned-code-0123456789" });
    expect(getSetting(pinned.db, "invite_pinned")).toBe("1");
    pinned.close();
    const free = buildServer(c);
    expect(getSetting(free.db, "invite_pinned")).toBe("0");
    free.close();
  });

  test("demo mode opens no database file and has no login", async () => {
    const c = serverConfig({ demo: true });
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
    const s = buildServer(serverConfig({ demo: true }));
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
    const s = buildServer(serverConfig());
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
    const s = buildServer(serverConfig({ trustedProxies: 1 }));
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
    const s = buildServer(serverConfig({ demo: true }), { webRoot: join(tempDir(), "missing") });
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
    const root = tempDir();
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
    const s = buildServer(serverConfig({ demo: true }), { webRoot: web });
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
  const c = serverConfig();
  const first = buildServer(c);
  first.close();
  const second = buildServer(c);
  expect(second.db.prepare("select count(*) as n from teams").get()).toEqual({ n: 1 });
  second.close();
});
