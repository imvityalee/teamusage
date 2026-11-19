import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "./api.js";
import { CollectError } from "./collect.js";
import { ConfigError } from "./config.js";
import { clearCodexNotice, isSetupProblem, noticePath, writeCodexNotice } from "./notice.js";
import { clientVersion } from "./codex.js";
import { SyncError } from "./sync.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "teamusage-notice-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test("notice is valid JSON for any message, mode 600", () => {
  const msg = 'bad "quote" and back\\slash\nnewline';
  writeCodexNotice(msg);
  expect(JSON.parse(readFileSync(noticePath(), "utf8"))).toEqual({
    systemMessage: `teamusage could not send your usage: ${msg} (in a terminal: npx -y teamusage@${clientVersion()} setup)`,
  });
  expect(statSync(noticePath()).mode & 0o777).toBe(0o600);
});

test("the notice names the npx setup command of this client's version", () => {
  writeCodexNotice("x");
  const text = JSON.parse(readFileSync(noticePath(), "utf8")).systemMessage as string;
  expect(text).toMatch(/\(in a terminal: npx -y teamusage@\d+\.\d+\.\d+ setup\)$/);
});

test("the notice is written through a temp file and leaves none behind", () => {
  writeCodexNotice("one");
  writeCodexNotice("two");
  expect(readdirSync(path.dirname(noticePath())).sort()).toEqual(["codex-notice.json"]);
});

test("clearCodexNotice removes the file and tolerates a missing one", () => {
  writeCodexNotice("x");
  clearCodexNotice();
  expect(existsSync(noticePath())).toBe(false);
  expect(() => clearCodexNotice()).not.toThrow();
});

test("a failing notice write is ignored", () => {
  const file = path.join(home, "blocked");
  writeFileSync(file, "");
  vi.stubEnv("XDG_CONFIG_HOME", file);
  expect(() => writeCodexNotice("x")).not.toThrow();
  expect(() => clearCodexNotice()).not.toThrow();
});

test("isSetupProblem: config and sync errors yes; api, collect, lock, unknown no", () => {
  expect(isSetupProblem(new ConfigError("x"))).toBe(true);
  expect(isSetupProblem(new SyncError("x"))).toBe(true);
  expect(isSetupProblem(new SyncError("lock", { notSetup: true }))).toBe(false);
  expect(isSetupProblem(new ApiError(500, "x"))).toBe(false);
  expect(isSetupProblem(new CollectError("x"))).toBe(false);
  expect(isSetupProblem(new Error("x"))).toBe(false);
});
