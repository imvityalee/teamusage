#!/usr/bin/env node
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { createApp } from "./app.js";
import type { AppOptions } from "./app-context.js";
import { parseServerConfig, type HostedConfig, type ServerConfig } from "./config.js";
import { getInviteCode, getStoredInviteCode, openDb, setSetting, type Db } from "./db.js";
import { claimDatabase } from "./db-mode.js";
import { seedDemo } from "./demo.js";
import { isMain } from "./entry.js";
import { githubClient, type GithubClient } from "./github.js";
import { hostedLimits, type HostedLimits } from "./hosted-limits.js";
import { hostedTeamCodes } from "./hosted-teams.js";
import { clientKeyFrom } from "./limiter.js";
import { codeOf, openFailureMessage } from "./open-failure.js";
import { pagesOf } from "./pages.js";
import type { DiskSpace } from "./storage-guard.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";
import { DEFAULT_WEB_ROOT, serveWeb } from "./web-files.js";

export { DEFAULT_WEB_ROOT };

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export interface BuiltServer {
  app: Hono;
  db: Db;
  /** The self-hosted team's invite code; undefined in hosted mode, where each team has its own. */
  inviteCode: (() => string) | undefined;
  /** True when this start generated the invite code (not demo, not the environment, not already stored, not hosted). */
  inviteGenerated: boolean;
  close: () => void;
}

/** The database: in memory for the demo, otherwise a private file in the data directory. */
function openStorage(config: ServerConfig): Db {
  if (config.demo) return openDb(":memory:");
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = join(config.dataDir, "teamusage.sqlite");
  // Create the file private before SQLite does; its -wal and -shm files inherit this mode.
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  return openDb(file);
}

type ClientKey = (c: Context) => string;

/** The client of a request for failed-attempt limiting: its socket address, or X-Forwarded-For behind trusted proxies. */
function clientKeyOf(trustedProxies: number): ClientKey {
  return (c) => {
    let remote: string | undefined;
    try {
      remote = getConnInfo(c).remote.address;
    } catch {
      remote = undefined;
    }
    return clientKeyFrom(remote, c.req.header("x-forwarded-for"), trustedProxies);
  };
}

type Api = { api: Hono; inviteCode: BuiltServer["inviteCode"]; inviteGenerated: boolean };

/**
 * What the app of either kind of server is given: how it tells clients apart, and a test's clock when it has one; a
 * hosted server's also a test's pause between the slices of a removal.
 */
type Wiring = Pick<AppOptions, "clientKey" | "now" | "removal">;

/** The API of a self-hosted server: one team, opened with the invite code. */
function selfHostedApi(db: Db, config: ServerConfig, wiring: Wiring): Api {
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
    ...wiring,
  });
  return { api, inviteCode, inviteGenerated };
}

/**
 * Replaces parts of a server for a test: the web directory, the GitHub client, the disk measurement, the clock and the
 * pause between the slices of a removal.
 */
type BuildOptions = {
  webRoot?: string;
  github?: GithubClient;
  measureDisk?: (dir: string) => DiskSpace;
  now?: () => number;
  pause?: () => Promise<void>;
};

/** The API of a hosted server: people sign in with GitHub and create teams, each with its own code, within its limits. */
function hostedApi(db: Db, hosted: HostedConfig, wiring: Wiring, github: GithubClient | undefined, limits: HostedLimits): Api {
  const { publicUrl, githubClientId: clientId, githubClientSecret: clientSecret, codeKey, maxTeams } = hosted;
  const api = createApp(db, {
    teamForCode: hostedTeamCodes(db),
    hosted: { github: github ?? githubClient({ clientId, clientSecret, publicUrl }), publicUrl, codeKey, maxTeams },
    limits,
    ...wiring,
  });
  return { api, inviteCode: undefined, inviteGenerated: false };
}

/** Security headers on every response; the API answers everything under `apiPaths`, the web directory's `pages` and files the rest. */
function serverApp(api: Hono, apiPaths: string[], webRoot: string, pages: Readonly<Record<string, string>>): Hono {
  const app = new Hono();
  app.use(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Content-Security-Policy", CSP);
  });
  // The API app answers everything under its paths, including its own 404s; the web directory never does.
  for (const path of apiPaths) app.all(path, (c) => api.fetch(c.req.raw, c.env));
  app.get("*", (c) => serveWeb(c, webRoot, pages));
  app.all("*", (c) => c.json({ error: "not found" }, 404));
  return app;
}

/**
 * Opens storage and wires the app. Starts no listener. In hosted mode `opts.github` replaces the GitHub client,
 * `opts.measureDisk` the measurement of the data volume (a self-hosted server never measures it) and `opts.pause` the
 * pause between the slices of a removal. In both modes `opts.now` replaces the app's clock.
 */
export function buildServer(config: ServerConfig, opts: BuildOptions = {}): BuiltServer {
  const db = openStorage(config);
  // Before anything is written: a database stays with the mode of the server that first used it.
  try {
    claimDatabase(db, config.mode);
  } catch (err) {
    db.close();
    throw err;
  }
  const wiring: Wiring = { clientKey: clientKeyOf(config.trustedProxies), now: opts.now };
  const hostedWiring: Wiring = { ...wiring, removal: { pause: opts.pause } };
  const { api, inviteCode, inviteGenerated } = config.hosted
    ? hostedApi(db, config.hosted, hostedWiring, opts.github, hostedLimits({ dataDir: config.dataDir, db, measure: opts.measureDisk }))
    : selfHostedApi(db, config, wiring);
  // A hosted server also signs people in under /auth.
  const apiPaths = config.hosted ? ["/api/*", "/auth/*"] : ["/api/*"];
  const app = serverApp(api, apiPaths, opts.webRoot ?? DEFAULT_WEB_ROOT, pagesOf(config.mode));
  return { app, db, inviteCode, inviteGenerated, close: () => db.close() };
}

/** Log lines after listening. The invite code appears only on the start that generated it; a hosted start shows none. */
export function startupLines(config: ServerConfig, built: BuiltServer, port: number): string[] {
  const lines = [`teamusage listening on http://${config.host}:${port}`];
  if (config.hosted) lines.push(`hosted mode: people sign in at ${config.hosted.publicUrl}/auth/github/start`);
  else if (config.demo) lines.push("demo mode: demo data is in memory and nothing is saved");
  else if (config.inviteCodeFromEnv) lines.push("invite code is set from the environment");
  else if (built.inviteGenerated && built.inviteCode) lines.push(`invite code (shown only now): ${built.inviteCode()}`);
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
