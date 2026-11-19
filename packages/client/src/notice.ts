import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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

/** Saves the message for the Codex hook to show; never throws. Only fixed client messages belong here. */
export function writeCodexNotice(message: string): void {
  try {
    const file = path.join(ensureConfigDir(), "codex-notice.json");
    const body = JSON.stringify({ systemMessage: `teamusage could not send your usage: ${message}` });
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // a notice must never make a sync fail
  }
}

export function clearCodexNotice(): void {
  try {
    rmSync(noticePath(), { force: true });
  } catch {
    // ignore
  }
}
