#!/usr/bin/env node
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { createApp } from "./app.js";
import { parseServerConfig, type ServerConfig } from "./config.js";
import { getInviteCode, getStoredInviteCode, openDb, setSetting, type Db } from "./db.js";
import { seedDemo } from "./demo.js";
import { isMain } from "./entry.js";
import { clientKeyFrom } from "./limiter.js";
import { codeOf, openFailureMessage } from "./open-failure.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const NOT_BUILT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>teamusage</title></head>' +
  "<body><h1>teamusage</h1><p>The dashboard is not built. The API is running.</p></body></html>";

/** packages/server/web/dist, from both src/main.ts and the built dist/main.js (siblings of web/). */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../web/dist", import.meta.url));

/** Serves files from `root` only. Anything that resolves outside it (dot segments, symlinks, encodings) is a 404. */
async function serveWeb(c: Context, root: string): Promise<Response> {
  const notFound = () => c.text("not found", 404);
  const index = join(root, "index.html");
  if (!existsSync(index)) return c.req.path === "/" ? c.html(NOT_BUILT) : notFound();
  let rel: string;
  try {
    // Decoded exactly once, from the raw path (c.req.path is already partly decoded).
    rel = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return notFound();
  }
  if (rel.includes("\0") || rel.includes("\\")) return notFound();
  if (rel.endsWith("/")) rel += "index.html";
  // No dotfiles or directories, and no source maps.
  if (rel.split("/").some((seg) => seg.startsWith(".")) || rel.toLowerCase().endsWith(".map")) return notFound();
  try {
    const base = realpathSync(root);
    const file = realpathSync(resolve(base, `.${rel}`));
    if (!file.startsWith(base + sep) || !statSync(file).isFile()) return notFound();
    const body = await readFile(file);
    const headers: Record<string, string> = {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    };
    if (file === join(base, "index.html")) headers["Cache-Control"] = "no-cache";
    else if (file.startsWith(join(base, "assets") + sep)) headers["Cache-Control"] = "public, max-age=31536000, immutable";
    return c.body(body, 200, headers);
  } catch {
    return notFound();
  }
}

export interface BuiltServer {
  app: Hono;
  db: Db;
  inviteCode: () => string;
  /** True when this start generated the invite code (not demo, not the environment, not already stored). */
  inviteGenerated: boolean;
  close: () => void;
}

/** Opens storage and wires the app. Starts no listener. */
export function buildServer(config: ServerConfig, opts: { webRoot?: string } = {}): BuiltServer {
  let db: Db;
  if (config.demo) {
    db = openDb(":memory:");
  } else {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const file = join(config.dataDir, "teamusage.sqlite");
    // Create the file private before SQLite does; its -wal and -shm files inherit this mode.
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
    db = openDb(file);
  }
  const fromEnv = config.demo ? undefined : config.inviteCodeFromEnv;
  const inviteGenerated = !config.demo && !fromEnv && getStoredInviteCode(db) === undefined;
  const inviteCode = () => getInviteCode(db, fromEnv);
  inviteCode(); // makes sure a code exists before anyone asks
  // Lets `teamusage-admin`, which runs without the server's environment, know the code is pinned.
  setSetting(db, "invite_pinned", fromEnv ? "1" : "0");

  const teamId = ensureSingleTeam(db);
  if (config.demo) seedDemo(db, teamId, new Date().toISOString().slice(0, 10));
  const api = createApp(db, {
    teamForCode: singleTeamCodes(teamId, inviteCode),
    demoTeamId: config.demo ? teamId : undefined,
    clientKey: (c) => {
      let remote: string | undefined;
      try {
        remote = getConnInfo(c).remote.address;
      } catch {
        remote = undefined;
      }
      return clientKeyFrom(remote, c.req.header("x-forwarded-for"), config.trustedProxies);
    },
  });

  const webRoot = opts.webRoot ?? DEFAULT_WEB_ROOT;
  const app = new Hono();
  app.use(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Content-Security-Policy", CSP);
  });
  // The API app answers everything under /api, including its own 404s; the web directory never does.
  app.all("/api/*", (c) => api.fetch(c.req.raw, c.env));
  app.get("*", (c) => serveWeb(c, webRoot));
  app.all("*", (c) => c.json({ error: "not found" }, 404));

  return { app, db, inviteCode, inviteGenerated, close: () => db.close() };
}

/** Log lines after listening. The invite code appears only on the start that generated it. */
export function startupLines(config: ServerConfig, built: BuiltServer, port: number): string[] {
  const lines = [`teamusage listening on http://${config.host}:${port}`];
  if (config.demo) lines.push("demo mode: demo data is in memory and nothing is saved");
  else if (config.inviteCodeFromEnv) lines.push("invite code is set from the environment");
  else if (built.inviteGenerated) lines.push(`invite code (shown only now): ${built.inviteCode()}`);
  else lines.push("an invite code is stored; show it with: teamusage-admin show-invite");
  return lines;
}

function start(): void {
  let config: ServerConfig;
  try {
    config = parseServerConfig(process.env, process.argv.slice(2));
  } catch (err) {
    console.error(`teamusage: ${(err as Error).message}`);
    process.exit(1);
  }
  let built: BuiltServer;
  try {
    built = buildServer(config);
  } catch (err) {
    console.error(openFailureMessage(err));
    process.exit(1);
  }
  // No createServer option is passed, so this is a plain HTTP/1 server.
  const server = serve({ fetch: built.app.fetch, port: config.port, hostname: config.host }, (info) => {
    for (const line of startupLines(config, built, info.port)) console.log(line);
  }) as Server;
  server.on("error", (err) => {
    console.error(`teamusage: could not listen on the configured address${codeOf(err)}`);
    process.exit(1);
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      try {
        built.close();
      } catch {
        // Nothing left to do; exiting is the goal.
      }
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (isMain(import.meta.url)) start();
