import { rmSync } from "node:fs";
import { ConfigError, configFile, writePrivateFile } from "./config.js";
import { SyncError } from "./errors.js";
import { clientVersion } from "./version.js";

const NOTICE_FILE = "codex-notice.json";

export function noticePath(): string {
  return configFile(NOTICE_FILE);
}

/** True for setup and token problems the user can fix: every ConfigError and every SyncError but the sync lock. */
export function isSetupProblem(e: unknown): boolean {
  return e instanceof ConfigError || (e instanceof SyncError && e.setupProblem);
}

/** Saves the message for the Codex hook to show; never throws. Only fixed client messages belong here. */
export function writeCodexNotice(message: string): void {
  try {
    const text = `teamusage could not send your usage: ${message} (in a terminal: npx -y teamusage@${clientVersion()} setup)`;
    writePrivateFile(NOTICE_FILE, JSON.stringify({ systemMessage: text }));
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
