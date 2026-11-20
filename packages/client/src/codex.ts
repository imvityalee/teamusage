import { statSync, accessSync, constants } from "node:fs";
import path from "node:path";
import { APP_NAME } from "@teamusage/shared";
import { UserError } from "./errors.js";
import { runProgram, type RunResult } from "./run.js";
import { clientVersion } from "./version.js";

export class CodexError extends UserError {}

export interface CodexDeps {
  /** Path of the `codex` program on PATH, or undefined. */
  find: () => string | undefined;
  run: (file: string, args: string[]) => Promise<RunResult>;
  version: () => string;
}

/** The first executable file called `name` in PATH. Looks only; runs nothing. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue; // "." would run a codex from the current directory
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** The arguments for `codex`; the version is pinned so Codex always starts the same client. */
export function codexAddArgs(version: string): string[] {
  return ["mcp", "add", APP_NAME, "--", "npx", "-y", `${APP_NAME}@${version}`, "mcp"];
}

export function codexDeps(over: Partial<CodexDeps> = {}, env: NodeJS.ProcessEnv = process.env): CodexDeps {
  return { find: () => findOnPath("codex", env), run: runProgram, version: clientVersion, ...over };
}

export async function registerCodex(d: CodexDeps): Promise<void> {
  const codex = d.find();
  if (!codex) throw new CodexError("codex was not found on PATH");
  const r = await d.run(codex, codexAddArgs(d.version()));
  if (r.code !== 0) throw new CodexError("`codex mcp add` failed; run it yourself to see why");
}
