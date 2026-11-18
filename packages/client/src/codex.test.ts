import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { codexAddArgs, findOnPath } from "./codex.js";

test("findOnPath skips relative PATH entries and finds an executable in an absolute one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "teamusage-path-"));
  const cwd = process.cwd();
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(path.join(bin, "codex"), 0o755);
    process.chdir(bin);
    expect(findOnPath("codex", { PATH: `.${path.delimiter}` })).toBeUndefined();
    expect(findOnPath("codex", { PATH: `bin${path.delimiter}${bin}` })).toBe(path.join(bin, "codex"));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true });
  }
});

test("codexAddArgs pins the version and runs through `--`", () => {
  expect(codexAddArgs("1.2.3")).toEqual(["mcp", "add", "teamusage", "--", "npx", "-y", "teamusage@1.2.3", "mcp"]);
});
