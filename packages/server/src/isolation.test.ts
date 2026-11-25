import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const NOT_PRODUCT_CODE = /\.(test|fixture|harness)\.ts$/;

/** Every product source file under src, as a path relative to src. */
function productFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productFiles(path);
    return entry.name.endsWith(".ts") && !NOT_PRODUCT_CODE.test(entry.name) ? [relative(SRC, path)] : [];
  });
}

/** The product files whose text matches, other than the allowed ones; an allowed entry ending in "/" is a directory. */
function offenders(pattern: RegExp, allowed: string[]): string[] {
  const isAllowed = (file: string) => allowed.some((a) => (a.endsWith("/") ? file.startsWith(a) : file === a));
  return productFiles().filter((file) => !isAllowed(file) && pattern.test(readFileSync(join(SRC, file), "utf8")));
}

test("only the team data layer, the stats rows and the upgrade steps write SQL on members, machines or usage", () => {
  expect(offenders(/\b(from|into|update|join)\s+(members|machines|usage)\b/i, ["team-data.ts", "stats-rows.ts", "migrations/"])).toEqual([]);
});
test("only a self-hosted server resolves the single team", () => {
  expect(offenders(/ensureSingleTeam/, ["teams.ts", "main.ts", "admin.ts"])).toEqual([]);
});
