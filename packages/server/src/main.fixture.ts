import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { ServerConfig } from "./config.js";

const dirs: string[] = [];
// Registered by every test file that imports this module: the directories its tests made are removed after each.
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A new empty temporary directory, removed after the test. */
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tu-main-"));
  dirs.push(d);
  return d;
}

/** A data directory that does not exist yet, inside a temporary directory removed after the test. */
export const tempDataDir = (): string => join(tempDir(), "data");

/** A self-hosted server's settings on a fresh data directory, with `over` applied. */
export const serverConfig = ({ dataDir = tempDataDir(), ...over }: Partial<ServerConfig> = {}): ServerConfig => ({
  port: 8787,
  host: "127.0.0.1",
  dataDir,
  inviteCodeFromEnv: undefined,
  demo: false,
  trustedProxies: 0,
  mode: "self-hosted",
  hosted: undefined,
  ...over,
});
