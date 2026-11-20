import { execFile } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an argument array, never through a shell, and resolves with its exit code and output.
 * A program that cannot start rejects.
 */
export function runProgram(file: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 30_000, maxBuffer: 1 << 20, windowsHide: true }, (e, stdout, stderr) => {
      if (e && typeof (e as NodeJS.ErrnoException).code !== "number") return reject(e);
      resolve({ code: e ? ((e as NodeJS.ErrnoException).code as unknown as number) : 0, stdout, stderr });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}
