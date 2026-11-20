import { readFileSync } from "node:fs";
import { UserError } from "./errors.js";

/** This client's own version, from its package.json (next to src/ and dist/). */
export function clientVersion(): string {
  const v = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v)) throw new UserError("could not read this client's version");
  return v;
}
