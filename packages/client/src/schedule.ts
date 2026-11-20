import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "@teamusage/shared";
import { configDir } from "./config.js";
import { UserError } from "./errors.js";
import { runProgram, type RunResult } from "./run.js";

/**
 * The scheduled job runs `<node> <cli> sync --quiet` every four hours. Nothing the user typed (name, email,
 * server, invite code) is ever written into the job or onto a command line; the job reads the config file.
 * Every external command is run with an argument array and no shell.
 */
export const LABEL = "com.teamusage.sync";
export const INTERVAL_SECONDS = 14400;
const TAG = "# teamusage";

export interface ScheduleDeps {
  /** Runs a program with an argument array (never a shell); a program that cannot start rejects. */
  run: (file: string, args: string[], input?: string) => Promise<RunResult>;
  /** Returns the file's text, or undefined if it does not exist. */
  readFile: (file: string) => string | undefined;
  /** Writes the file atomically with the given mode, creating its directory. */
  writeFile: (file: string, data: string, mode: number) => void;
  rm: (file: string) => void;
  exists: (file: string) => boolean;
  homedir: () => string;
  env: NodeJS.ProcessEnv;
  uid: () => number | undefined;
  nodePath: string;
  cliPath: () => string;
}

interface JobPaths {
  nodePath: string;
  cliPath: string;
}

export class ScheduleError extends UserError {}

const CONTROL = /[\u0000-\u001f\u007f]/;

function checkPath(p: string, what: string): void {
  if (!p || CONTROL.test(p)) throw new ScheduleError(`the ${what} path contains a control character or is empty`);
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function launchdPlist(a: JobPaths): string {
  checkPath(a.nodePath, "Node");
  checkPath(a.cliPath, "client");
  const args = [a.nodePath, a.cliPath, "sync", "--quiet"].map((s) => `    <string>${xml(s)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function cronLine(a: JobPaths): string {
  for (const [p, what] of [[a.nodePath, "Node"], [a.cliPath, "client"]] as const) {
    checkPath(p, what);
    if (p.includes("%")) throw new ScheduleError(`the ${what} path contains "%", which cron cannot take; install the client in another folder`);
  }
  return `17 */4 * * * ${shellQuote(a.nodePath)} ${shellQuote(a.cliPath)} sync --quiet ${TAG}`;
}

interface Entry {
  body: string; // the line without its ending (a stray "\r" on an unterminated last line stays)
  eol: string; // "\n", "\r\n", or "" for an unterminated last line
}

function parseCrontab(text: string): Entry[] {
  const pieces = text.split("\n");
  const last = pieces.pop() as string; // "" when the text ends with a newline
  const entries = pieces.map((p): Entry => (p.endsWith("\r") ? { body: p.slice(0, -1), eol: "\r\n" } : { body: p, eol: "\n" }));
  if (last !== "") entries.push({ body: last, eol: "" });
  return entries;
}

/** CRLF if most terminated lines end that way, else LF. */
function prevailingEol(entries: Entry[]): string {
  const crlf = entries.filter((e) => e.eol === "\r\n").length;
  return crlf > entries.filter((e) => e.eol === "\n").length ? "\r\n" : "\n";
}

const render = (entries: Entry[]) => {
  const eol = prevailingEol(entries);
  return entries.map((e) => e.body + (e.eol || eol)).join("");
};

const QUOTED = String.raw`('(?:[^']|'\\'')*')`;
const OURS = new RegExp(String.raw`^17 \*/4 \* \* \* ${QUOTED} ${QUOTED} sync --quiet ${TAG}$`);
/** Only the exact line `cronLine` writes; a user's own line that merely ends in the tag is not ours. */
const isOurs = (body: string) => OURS.test(body.endsWith("\r") ? body.slice(0, -1) : body);

/** Replaces our line (or appends it), keeping every other line, its order and its ending. */
export function mergeCrontab(existing: string, line: string): string {
  if (/[\r\n]/.test(line) || !isOurs(line)) throw new ScheduleError("the cron line is not the one this tool writes");
  const entries = parseCrontab(existing);
  const eol = prevailingEol(entries);
  const out: Entry[] = [];
  let placed = false;
  for (const e of entries) {
    if (!isOurs(e.body)) out.push(e);
    else if (!placed) {
      out.push({ body: line, eol: e.eol });
      placed = true;
    }
  }
  if (!placed) out.push({ body: line, eol });
  return render(out);
}

/** Drops only our lines; the rest keep their bytes. Returns null if there was none, "" if nothing is left. */
export function removeFromCrontab(existing: string): string | null {
  const entries = parseCrontab(existing);
  if (!entries.some((e) => isOurs(e.body))) return null;
  const kept = entries.filter((e) => !isOurs(e.body));
  return kept.length === 0 ? "" : render(kept);
}

/** The two paths recorded in our cron line, or undefined. */
export function parseCronLine(body: string): { nodePath: string; cliPath: string } | undefined {
  const m = OURS.exec(body.endsWith("\r") ? body.slice(0, -1) : body);
  if (!m) return undefined;
  const unquote = (q: string) => q.slice(1, -1).replace(/'\\''/g, "'");
  return { nodePath: unquote(m[1]!), cliPath: unquote(m[2]!) };
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The two paths recorded in our plist's ProgramArguments, or undefined. */
export function parsePlist(text: string): { nodePath: string; cliPath: string } | undefined {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const items = [...(m?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((x) => unxml(x[1]!));
  return items.length >= 2 ? { nodePath: items[0]!, cliPath: items[1]! } : undefined;
}

export function realDeps(): ScheduleDeps {
  return {
    run: (file, args, input) => {
      // launchctl and crontab are called by absolute path, so nothing earlier in PATH can stand in for them.
      const abs = file === "launchctl" ? "/bin/launchctl" : file === "crontab" ? "/usr/bin/crontab" : undefined;
      return runProgram(abs && existsSync(abs) ? abs : file, args, input);
    },
    readFile: (f) => {
      try {
        return readFileSync(f, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    writeFile: (f, data, mode) => {
      mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(tmp, data, { mode, flag: "wx" });
        chmodSync(tmp, mode); // the umask must not narrow it
        renameSync(tmp, f);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    },
    rm: (f) => rmSync(f, { force: true }),
    exists: (f) => existsSync(f),
    homedir,
    env: process.env,
    uid: () => process.getuid?.(),
    nodePath: process.execPath,
    cliPath: () => realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url))),
  };
}

const withDeps = (d?: Partial<ScheduleDeps>): ScheduleDeps => ({ ...realDeps(), ...d });
const plistPath = (d: ScheduleDeps) => path.join(d.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function noCrontab(r: RunResult): boolean {
  return r.code !== 0 && /no crontab/i.test(r.stderr);
}

async function readCrontab(d: ScheduleDeps): Promise<string> {
  const r = await d.run("crontab", ["-l"]);
  if (r.code === 0) return r.stdout;
  if (noCrontab(r)) return "";
  // Anything else: do not guess, or a write could replace a crontab that could not be read.
  throw new ScheduleError("could not read the current crontab, so nothing was changed");
}

async function writeCrontab(d: ScheduleDeps, text: string): Promise<void> {
  const r = text === "" ? await d.run("crontab", ["-r"]) : await d.run("crontab", ["-"], text);
  if (r.code !== 0) throw new ScheduleError("could not write the crontab");
}

const CACHE_PATHS = [
  /[\\/]_npx[\\/]/, // npx
  /[\\/]dlx[\\/]/, // pnpm dlx: <cache-dir>/dlx/<hash>/...
  /[\\/]dlx-/, // older pnpm dlx, and yarn dlx (a temp folder named dlx-<pid>)
  /[\\/]bunx-/, // bunx temp folders
  /[\\/]\.bun[\\/]install[\\/]cache[\\/]/, // bun's package cache
  /[\\/]\.yarn[\\/]berry[\\/]cache[\\/]/, // yarn berry's cache
];
const GLOBAL_PREFIXES = [
  /[\\/]lib[\\/]node_modules[\\/]/, // npm -g on macOS and Linux (also nvm, fnm, volta, Homebrew)
  /[\\/]npm[\\/]node_modules[\\/]/, // npm -g on Windows
  /[\\/]pnpm[\\/]global[\\/]/,
  /[\\/]\.bun[\\/]install[\\/]global[\\/]/,
  /[\\/]yarn[\\/]global[\\/]/,
];

/** True if the client lives somewhere that can vanish or move: a download cache or a project's node_modules. */
export function unstableLocation(cliPath: string): boolean {
  if (CACHE_PATHS.some((r) => r.test(cliPath))) return true;
  return /[\\/]node_modules[\\/]/.test(cliPath) && !GLOBAL_PREFIXES.some((r) => r.test(cliPath));
}

/** Installs the job. `platform` and `deps` are for tests. */
export async function installSchedule(platform: NodeJS.Platform = process.platform, deps?: Partial<ScheduleDeps>): Promise<string> {
  if (platform === "win32") throw new ScheduleError("Scheduled sync on Windows is not supported yet.");
  if (platform !== "darwin" && platform !== "linux") throw new ScheduleError(`Scheduled sync is not supported on ${platform}.`);
  const d = withDeps(deps);
  const uid = d.uid();
  if (uid === 0) throw new ScheduleError("Refusing to install a scheduled job as root; run this as your own user.");
  // launchd and cron start the job without XDG_CONFIG_HOME, so it finds only the default config directory.
  if (configDir(d.env, d.homedir()) !== path.join(d.homedir(), ".config", APP_NAME)) {
    throw new ScheduleError(
      "The scheduled job cannot see a custom config location (XDG_CONFIG_HOME is set). Run `teamusage setup` without XDG_CONFIG_HOME, then install the schedule again.",
    );
  }
  const cliPath = d.cliPath();
  if (unstableLocation(cliPath)) {
    throw new ScheduleError(
      "This client is running from a download cache (npx, pnpm dlx, bunx, yarn dlx) or a project's node_modules, which can disappear or move. Install it first with `npm install -g teamusage`, then run this again.",
    );
  }
  const job = { nodePath: d.nodePath, cliPath };
  const reinstall = "Run `teamusage schedule install` again after upgrading Node or moving the client.";
  if (platform === "darwin") {
    if (uid === undefined) throw new ScheduleError("could not tell which user this is");
    const file = plistPath(d);
    const plist = launchdPlist(job);
    await unloadJob(d, uid, file); // replaces a job that already exists
    d.writeFile(file, plist, 0o644);
    const boot = await d.run("launchctl", ["bootstrap", `gui/${uid}`, file]);
    if (boot.code !== 0) {
      const load = await d.run("launchctl", ["load", "-w", file]);
      if (load.code !== 0) {
        d.rm(file);
        throw new ScheduleError("launchctl could not load the job");
      }
    }
    return `Installed the scheduled sync (every 4 hours): ${file}\n${reinstall}`;
  }
  const line = cronLine(job);
  await writeCrontab(d, mergeCrontab(await readCrontab(d), line));
  return `Installed the scheduled sync (every 4 hours) in your crontab, tagged # teamusage.\n${reinstall}`;
}

async function unloadJob(d: ScheduleDeps, uid: number, file: string): Promise<void> {
  const r = await d.run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => ({ code: 1 }) as RunResult);
  if (r.code !== 0 && d.readFile(file) !== undefined) await d.run("launchctl", ["unload", file]).catch(() => undefined);
}

export async function removeSchedule(platform: NodeJS.Platform = process.platform, deps?: Partial<ScheduleDeps>): Promise<void> {
  if (platform === "win32") throw new ScheduleError("Scheduled sync on Windows is not supported yet.");
  if (platform !== "darwin" && platform !== "linux") throw new ScheduleError(`Scheduled sync is not supported on ${platform}.`);
  const d = withDeps(deps);
  if (platform === "darwin") {
    const uid = d.uid();
    if (uid === undefined) throw new ScheduleError("could not tell which user this is");
    const file = plistPath(d);
    await unloadJob(d, uid, file);
    // Read-only check; if the job is still loaded, keep the file so that this can be retried.
    const still = await d.run("launchctl", ["print", `gui/${uid}/${LABEL}`]).catch(() => undefined);
    if (!still) throw new ScheduleError("could not confirm that the job is unloaded; the plist was kept");
    if (still.code === 0) throw new ScheduleError("the job is still loaded; try `launchctl bootout gui/$(id -u)/com.teamusage.sync`");
    d.rm(file);
    return;
  }
  const next = removeFromCrontab(await readCrontab(d));
  if (next !== null) await writeCrontab(d, next);
}

export type ScheduleStatus = "installed" | "broken" | "not installed" | "unknown" | "unsupported";

/** Read-only and never throws: is the job installed, and do the paths it recorded still exist? */
export async function scheduleStatus(platform: NodeJS.Platform = process.platform, deps?: Partial<ScheduleDeps>): Promise<ScheduleStatus> {
  if (platform !== "darwin" && platform !== "linux") return "unsupported";
  try {
    const d = withDeps(deps);
    let paths: { nodePath: string; cliPath: string } | undefined;
    if (platform === "darwin") {
      const text = d.readFile(plistPath(d));
      if (text === undefined) return "not installed";
      paths = parsePlist(text);
    } else {
      const line = parseCrontab(await readCrontab(d)).find((e) => isOurs(e.body));
      if (!line) return "not installed";
      paths = parseCronLine(line.body);
    }
    if (!paths) return "unknown";
    return d.exists(paths.nodePath) && d.exists(paths.cliPath) ? "installed" : "broken";
  } catch {
    return "unknown";
  }
}
