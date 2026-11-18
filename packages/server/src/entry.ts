import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when this module is the program being run (also through a bin symlink), not merely imported. */
export function isMain(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
