#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { APP_NAME } from "@teamusage/shared";
import { insecureHttpAllowedByEnv, isInsecureRemoteHttp, loadConfig, type Config } from "./config.js";
import type { Stats } from "@teamusage/shared";
import { ApiError } from "./api.js";
import { defaults as mcpDefaults, COST_NOTE, loadStats, startMcp, RANGES, type Range } from "./mcp.js";
import { clean } from "./text.js";
import { errorMessage, getStatus, SyncError, parseThrottle, readLastAttempt, setup, shouldSkip, sync, writeLastAttempt, type Deps } from "./sync.js";
import { codexDeps, registerCodex, type CodexDeps } from "./codex.js";
import { installSchedule, removeSchedule, ScheduleError, scheduleStatus, type ScheduleDeps } from "./schedule.js";

/** `Deps` plus test hooks for the scheduled job, Codex and the terminal; the real entry point passes none. */
export type CliDeps = Partial<Deps> & {
  schedule?: Partial<ScheduleDeps>;
  platform?: NodeJS.Platform;
  codex?: Partial<CodexDeps>;
  interactive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
};

const USAGE = `Usage: ${APP_NAME} <command> [options]

Commands:
  setup [--server <url>] [--invite <code>] [--name <name>] [--email <email>] [--save-invite]
        [--allow-insecure-http] [--schedule] [--codex | --no-codex]
      Register this machine with a ${APP_NAME} server, save the config and run the first sync.
      Asks for anything not given. The invite code is stored only with --save-invite.
      Plain http is accepted only for localhost unless --allow-insecure-http is given.
      --schedule   also install the scheduled sync (every 4 hours; macOS and Linux)
      --codex      register the MCP tools with Codex without asking (needs \`codex\` on PATH)
      --no-codex   do not offer to register with Codex
      If \`codex\` is on PATH, an interactive setup asks (default yes) whether to register with it.
  schedule install|remove
      Install or remove the job that runs "sync --quiet" every 4 hours (launchd on macOS, cron on Linux).
      Install the client globally first: npm install -g ${APP_NAME}
  sync [--dry-run] [--quiet] [--detach] [--throttle <duration>] [--label-history]
      Collect usage with ccusage and upload it.
      --dry-run  print exactly what would be sent, and send nothing (--detach is then ignored)
      --quiet    print nothing and always exit 0 (failures go to sync.log in the config directory)
      --detach   start "sync --quiet" in the background and return at once
      --throttle <n>m|<n>h   do nothing when a sync was attempted less than that long ago (1m-1440m or 1h-24h)
      --label-history   send all history again and label every Claude and Codex day with the current login
                        (cannot be combined with --detach or --throttle)
  status
      Show the configuration, the last successful sync and whether the server is reachable.
  stats [--range 1m|3m|6m]
      Show your own usage per model and the team total (default 1m = the last 30 days).
  mcp
      Serve the tools sync_usage, get_my_usage and get_team_usage to an MCP client over stdio.
`;

const message = (e: unknown) => (e instanceof ScheduleError ? e.message : errorMessage(e));
const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

/** Prompts on the terminal; `secret` does not echo what is typed. No history, so nothing can be recalled. */
function prompter() {
  let rl: Interface | undefined;
  let muted = false;
  const open = () =>
    (rl ??= createInterface({
      input: process.stdin,
      output: new Writable({
        write(chunk, _enc, cb) {
          if (!muted) process.stdout.write(chunk);
          cb();
        },
      }),
      terminal: true,
      historySize: 0,
    }));
  return {
    text: (q: string) => open().question(q),
    async secret(q: string) {
      const r = open();
      out(q);
      muted = true;
      try {
        return await r.question("");
      } finally {
        muted = false;
        out("\n");
      }
    },
    close: () => rl?.close(),
  };
}

async function runSetup(args: string[], deps: CliDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string" },
      invite: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      "save-invite": { type: "boolean" },
      "allow-insecure-http": { type: "boolean" },
      schedule: { type: "boolean" },
      codex: { type: "boolean" },
      "no-codex": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.codex && values["no-codex"]) {
    err(`${APP_NAME} setup: --codex and --no-codex cannot be used together\n`);
    return 2;
  }
  let existing: Config | null = null;
  try {
    existing = loadConfig(env);
  } catch {
    // a broken config is replaced by setup
  }
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  const ask = prompter();
  const value = async (flag: string | undefined, current: string | undefined, label: string, option: string) => {
    if (flag !== undefined) return flag;
    if (interactive) {
      const answer = (await ask.text(current ? `${label} [${current}]: ` : `${label}: `)).trim();
      if (answer || current) return answer || current!;
    } else if (current) {
      return current;
    }
    throw new Error(`missing ${option}`);
  };
  let input;
  try {
    const serverUrl = await value(values.server, existing?.serverUrl, "Server URL", "--server");
    let inviteCode = values.invite ?? existing?.inviteCode;
    if (inviteCode === undefined && interactive) inviteCode = (await ask.secret("Invite code (not shown): ")).trim();
    if (!inviteCode) throw new Error("missing --invite");
    const name = await value(values.name, existing?.name, "Your name", "--name");
    const email = await value(values.email, existing?.email, "Your email", "--email");
    input = {
      serverUrl,
      inviteCode,
      name,
      email,
      saveInvite: values["save-invite"] === true,
      allowInsecureHttp: values["allow-insecure-http"] === true,
    };
  } catch (e) {
    err(`${APP_NAME} setup: ${e instanceof Error && e.message.startsWith("missing --") ? e.message : "could not read input"}\n`);
    return 2;
  } finally {
    ask.close();
  }

  if ((input.allowInsecureHttp || insecureHttpAllowedByEnv(env)) && isInsecureRemoteHttp(input.serverUrl)) {
    err(`Warning: plain http to a remote host; the token and invite code will be sent unencrypted.\n`);
  }
  const who = await setup(input, env);
  out(`Registered ${who.name} <${who.email}> with ${who.serverUrl}.\n`);
  let code = 0;
  // Only what the user asked for: --schedule, --codex, or a yes at the Codex prompt.
  if (values.schedule) {
    try {
      out(`${await installSchedule(deps.platform, deps.schedule)}\n`);
    } catch (e) {
      err(`${APP_NAME}: setup is saved, but the schedule was not installed: ${message(e)}\n`);
      code = 1;
    }
  }
  if (!values["no-codex"]) code = (await offerCodex(values.codex === true, interactive, deps)) || code;
  out("Running the first sync...\n");
  try {
    await sync({ deps });
  } catch (e) {
    err(`${APP_NAME}: setup is saved, but the first sync failed: ${errorMessage(e)}\n`);
    return 1;
  }
  return code;
}

async function offerCodex(flag: boolean, interactive: boolean, deps: CliDeps): Promise<number> {
  const codex = codexDeps(deps.codex, deps.env ?? process.env);
  if (!codex.find()) {
    if (!flag) return 0; // no Codex here: say nothing
    err(`${APP_NAME}: codex was not found on PATH, so it was not registered\n`);
    return 1;
  }
  if (!flag) {
    if (!interactive) return 0;
    let yes: boolean;
    if (deps.confirm) yes = await deps.confirm("Register the MCP tools with Codex? [Y/n] ");
    else {
      const ask = prompter();
      try {
        yes = !/^n/i.test((await ask.text("Register the MCP tools with Codex? [Y/n] ")).trim());
      } finally {
        ask.close();
      }
    }
    if (!yes) return 0;
  }
  try {
    await registerCodex(codex);
    out("Registered the MCP tools with Codex.\n");
    return 0;
  } catch (e) {
    err(`${APP_NAME}: ${message(e)}\n`);
    return 1;
  }
}

async function runSchedule(args: string[], deps: CliDeps): Promise<number> {
  const { positionals } = parseArgs({ args, options: {}, strict: true, allowPositionals: true });
  if (positionals.length !== 1 || (positionals[0] !== "install" && positionals[0] !== "remove")) {
    err(`${APP_NAME}: use \`${APP_NAME} schedule install\` or \`${APP_NAME} schedule remove\`\n`);
    return 2;
  }
  if (positionals[0] === "install") out(`${await installSchedule(deps.platform, deps.schedule)}\n`);
  else {
    await removeSchedule(deps.platform, deps.schedule);
    out("Removed the scheduled sync.\n");
  }
  return 0;
}

async function runSync(args: string[], deps: Partial<Deps>): Promise<number> {
  if (args.includes("--label-history") && (args.includes("--detach") || args.some((a) => a === "--throttle" || a.startsWith("--throttle=")))) {
    throw new SyncError("--label-history cannot be used with --detach or --throttle");
  }
  const dryRun = args.includes("--dry-run");
  // --dry-run wins over --detach: a dry run never goes to the background and never sends anything.
  const quiet = args.includes("--quiet") || (args.includes("--detach") && !dryRun);
  try {
    const { values } = parseArgs({
      args,
      options: { "dry-run": { type: "boolean" }, quiet: { type: "boolean" }, detach: { type: "boolean" }, throttle: { type: "string" }, "label-history": { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.throttle !== undefined) {
      const ms = parseThrottle(values.throttle);
      if (ms === undefined) {
        throw Object.assign(new Error("invalid --throttle"), { code: "ERR_PARSE_ARGS_INVALID_THROTTLE" });
      }
      // Checked before detaching, so nothing is spawned when the window has not passed. A dry run never skips.
      if (!values["dry-run"] && shouldSkip(ms, new Date(), readLastAttempt)) {
        if (!quiet) out(`Skipped: the last sync attempt was less than ${values.throttle} ago.\n`);
        return 0;
      }
      // The window starts here, before anything can fail (config, token, lock) and before the child exists.
      if (!values["dry-run"]) writeLastAttempt();
    }
    if (values.detach && !values["dry-run"]) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "sync", "--quiet"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
      return 0;
    }
    await sync({ dryRun: values["dry-run"] === true, quiet, labelHistory: values["label-history"] === true, deps });
    return 0;
  } catch (e) {
    if (quiet) return 0;
    throw e;
  }
}

const SCHEDULE_TEXT = {
  installed: "installed (every 4 hours)",
  broken: `installed but broken \u2014 run \`${APP_NAME} schedule install\` again`,
  "not installed": "not installed",
  unknown: "unknown (could not be read)",
  unsupported: "not supported on this system",
} as const;

async function runStatus(args: string[], deps: CliDeps): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
  const s = await getStatus(deps.env);
  const invite = { saved: "saved in the config", environment: "from the environment", none: "none" }[s.inviteCode];
  const agents = s.lastSyncAgents === undefined ? "none yet" : s.lastSyncAgents.join(", ") || "none";
  const lines = [
    `Config file:          ${s.configPath}`,
    `Server:               ${s.serverUrl ? `${s.serverUrl} (${s.serverReachable ? "reachable" : "not reachable"})` : "not set"}`,
    `Member:               ${s.name && s.email ? `${s.name} <${s.email}>` : "not set"}`,
    `Machine:              ${s.machineLabel}`,
    `Token:                ${s.hasToken ? "present" : "none"}`,
    `Invite code:          ${invite}`,
    `Last sync:            ${s.lastSuccessfulSync ?? "never"}`,
    `Agents (last sync):   ${agents}`,
    `Scheduled sync:       ${SCHEDULE_TEXT[await scheduleStatus(deps.platform, deps.schedule)]}`,
  ];
  out(`${lines.join("\n")}\n`);
  if (!s.configured) {
    out(`\n${APP_NAME} is not set up; run \`${APP_NAME} setup\`.\n`);
    return 1;
  }
  return 0;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const n = (v: number) => Math.round(v).toLocaleString("en-US");
const usd = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function runStats(args: string[], deps: Partial<Deps>): Promise<number> {
  const { values } = parseArgs({ args, options: { range: { type: "string" } }, strict: true, allowPositionals: false });
  const range = values.range ?? "1m";
  if (!(RANGES as readonly string[]).includes(range)) {
    err(`${APP_NAME}: --range must be 1m, 3m or 6m\n`);
    return 2;
  }
  const d = { ...mcpDefaults(), ...deps };
  const mine = await loadStats("me", range as Range, d);
  const team = await loadStats(undefined, range as Range, d);
  const bad = () => new ApiError(200, "the server sent an unexpected response");
  const okShape = (s: Stats) =>
    typeof s === "object" && s !== null && Array.isArray(s.models) && typeof s.totals === "object" && s.totals !== null &&
    s.models.every((m) => typeof m === "object" && m !== null) && /^\d{4}-\d{2}-\d{2}$/.test(String(s.from)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(s.to));
  if (!okShape(mine) || !okShape(team)) throw bad();
  const rows = [
    ["Agent", "Model", "Tokens", "Cost (USD)"],
    ...mine.models.map((m) => [clean(m.agent), clean(m.model), n(num(m.total)), usd(num(m.costUsd))]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) =>
    r.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ").trimEnd();
  out(`Your usage, ${clean(mine.from)} to ${clean(mine.to)}\n${rows.map(line).join("\n")}\n`);
  out(`Team total: ${n(num(team.totals.tokens))} tokens, ${usd(num(team.totals.costUsd))} USD\n${COST_NOTE}\n`);
  return 0;
}

/** Runs one command and returns the exit code. `deps` is for tests; the real entry point passes none. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    out(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case "setup":
        return await runSetup(rest, deps);
      case "schedule":
        return await runSchedule(rest, deps);
      case "sync":
        return await runSync(rest, deps);
      case "status":
        return await runStatus(rest, deps);
      case "stats":
        return await runStats(rest, deps);
      case "mcp":
        parseArgs({ args: rest, options: {}, strict: true, allowPositionals: false });
        await startMcp();
        return 0;
      default:
        err(USAGE);
        return 2;
    }
  } catch (e) {
    // parseArgs messages can quote what was typed (perhaps an invite code), so they are not shown.
    const usage = e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS");
    err(`${APP_NAME}: ${usage ? `invalid arguments; see \`${APP_NAME} --help\`` : message(e)}\n`);
    return usage ? 2 : 1;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = argv.includes("--quiet") || (argv.includes("--detach") && !argv.includes("--dry-run")) ? 0 : 1;
    },
  );
}
