import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { ServerConfig } from "./config.js";
import { fakeGithub, KEY } from "./hosted.fixture.js";
import type { DiskSpace } from "./storage-guard.js";

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

/** The public URL of the hosted test server. */
export const PUBLIC_URL = "https://usage.example.org";
/** The GitHub client secret of the hosted test server. */
export const SECRET = "github-secret-value-0123";

/** A hosted server's settings on `dataDir`, with the fixture's code key and room for 200 teams. */
export const hosted = (dataDir: string): ServerConfig =>
  serverConfig({
    dataDir,
    mode: "hosted",
    hosted: { publicUrl: PUBLIC_URL, githubClientId: "github-client-id", githubClientSecret: SECRET, codeKey: KEY, maxTeams: 200 },
  });

/** A data volume with room: a hosted server in a test measures this one, never the real disk. */
export const roomy = (): DiskSpace => ({ free: 90e9, total: 100e9 });

/** A fake GitHub that signs ann in with the callback code "code-ann". */
export const github = () => fakeGithub({ "code-ann": { id: 1, login: "ann" } });

/** The connection of a request from `address`, as the Node server passes it to the app. */
export const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
/** The connection of a request from 1.2.3.4. */
export const conn = from("1.2.3.4");
