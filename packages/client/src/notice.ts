import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { clientVersion } from "./codex.js";
import { ConfigError, configDir, ensureConfigDir } from "./config.js";

export function noticePath(): string {
  return path.join(configDir(), "codex-notice.json");
}

/**
 * True for setup and token problems the user can fix: every ConfigError and every SyncError except those marked
 * `notSetup` (the sync lock). Network, server and collect errors are not setup problems.
 * SyncError is recognised by name so this module need not import sync.ts.
 */
export function isSetupProblem(e: unknown): boolean {
  if (e instanceof ConfigError) return true;
  if (e instanceof Error && e.name === "SyncError") return (e as { notSetup?: boolean }).notSetup !== true;
  return false;
}

/**
 * Saves the message for the Codex hook to show; never throws. Only fixed client messages belong here.
 * Written through a temp file in the same directory, then renamed, so the hook never prints half a file.
 */
export function writeCodexNotice(message: string): void {
  let tmp: string | undefined;
  try {
    const dir = ensureConfigDir();
    const text = `teamusage could not send your usage: ${message} (in a terminal: npx -y teamusage@${clientVersion()} setup)`;
    tmp = path.join(dir, `.codex-notice.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ systemMessage: text }));
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path.join(dir, "codex-notice.json"));
    tmp = undefined;
  } catch {
    // a notice must never make a sync fail
  } finally {
    if (tmp !== undefined) rmSync(tmp, { force: true });
  }
}

export function clearCodexNotice(): void {
  try {
    rmSync(noticePath(), { force: true });
  } catch {
    // ignore
  }
}
