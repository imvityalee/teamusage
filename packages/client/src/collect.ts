import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  isIsoDate,
  MAX_AGENT_CHARS,
  MAX_COST_USD,
  MAX_MODEL_CHARS,
  MAX_TOKENS,
  NAME_CONTROL_CHARS,
  type UsageRecord,
} from "@teamusage/shared";
import { UserError } from "./errors.js";

export class CollectError extends UserError {}

const TIMEOUT_MS = 120_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function count(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new CollectError(`unexpected ccusage output: ${key} is not a non-negative integer`);
  }
  return v;
}

function text(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) throw new CollectError(`unexpected ccusage output: ${key} is not a string`);
  return v;
}

function cost(o: Obj): number {
  const v = o.cost;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new CollectError("unexpected ccusage output: invalid cost");
  return v;
}

/** The characters the server refuses in names (see validateBatch), for removal. */
const CONTROL_GLOBAL = new RegExp(NAME_CONTROL_CHARS.source, "g");

/**
 * A name the server accepts: control characters removed, then cut to `max` UTF-16 code units without
 * splitting a surrogate pair.
 */
function name(o: Obj, key: string, max: number): string {
  let out = "";
  for (const ch of text(o, key).replace(CONTROL_GLOBAL, "")) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  if (out === "") throw new CollectError(`unexpected ccusage output: ${key} is empty`);
  return out;
}

const OVER_LIMIT = "unexpected ccusage output: token counts or cost above the upload limits";

/** The server refuses anything above its upload limits, so it fails here with a fixed message instead. */
function withinLimits(r: UsageRecord): UsageRecord {
  const counts = [r.input, r.output, r.cacheCreate, r.cacheRead];
  if (counts.some((n) => n > MAX_TOKENS) || r.costUsd > MAX_COST_USD) throw new CollectError(OVER_LIMIT);
  return r;
}

/**
 * Copies only the named fields; nothing else from ccusage's output is kept. Breakdowns that share a day,
 * agent and model (also once names are shortened) are merged into one record.
 */
export function toRecords(ccusageJson: unknown): UsageRecord[] {
  if (!isObj(ccusageJson) || !Array.isArray(ccusageJson.daily)) {
    throw new CollectError("unexpected ccusage output: missing daily array");
  }
  const out: UsageRecord[] = [];
  for (const day of ccusageJson.daily) {
    if (!isObj(day)) throw new CollectError("unexpected ccusage output: day is not an object");
    const date = text(day, "period");
    if (!isIsoDate(date)) throw new CollectError("unexpected ccusage output: invalid period");
    if (!Array.isArray(day.agents)) throw new CollectError("unexpected ccusage output: day has no agents array");
    // Keyed by agent and model; neither contains control characters, so "\0" cannot occur inside them.
    const merged = new Map<string, UsageRecord>();
    for (const agentEntry of day.agents) {
      if (!isObj(agentEntry)) throw new CollectError("unexpected ccusage output: agent is not an object");
      const agent = name(agentEntry, "agent", MAX_AGENT_CHARS);
      if (!Array.isArray(agentEntry.modelBreakdowns)) {
        throw new CollectError("unexpected ccusage output: agent has no modelBreakdowns array");
      }
      for (const b of agentEntry.modelBreakdowns) {
        if (!isObj(b)) throw new CollectError("unexpected ccusage output: breakdown is not an object");
        const model = name(b, "modelName", MAX_MODEL_CHARS);
        const input = count(b, "inputTokens");
        const output = count(b, "outputTokens");
        const cacheCreate = count(b, "cacheCreationTokens");
        const cacheRead = count(b, "cacheReadTokens");
        const costUsd = cost(b);
        const unpriced = b.missingPricing === true;
        if (input + output + cacheCreate + cacheRead === 0) continue;
        const key = `${agent}\0${model}`;
        const prev = merged.get(key);
        if (prev) {
          prev.input += input;
          prev.output += output;
          prev.cacheCreate += cacheCreate;
          prev.cacheRead += cacheRead;
          prev.total = prev.input + prev.output + prev.cacheCreate + prev.cacheRead;
          prev.costUsd += costUsd;
          prev.unpriced = prev.unpriced || unpriced;
        } else {
          merged.set(key, {
            date, agent, model, input, output, cacheCreate, cacheRead,
            total: input + output + cacheCreate + cacheRead, costUsd, unpriced,
          });
        }
      }
    }
    for (const r of merged.values()) {
      r.costUsd = Math.round(r.costUsd * 1e6) / 1e6;
      out.push(withinLimits(r));
    }
  }
  return out;
}

function ccusageBin(): string {
  const require = createRequire(import.meta.url);
  let pkgPath: string;
  let bin: unknown;
  try {
    pkgPath = require.resolve("ccusage/package.json");
    bin = (JSON.parse(readFileSync(pkgPath, "utf8")) as Obj).bin;
  } catch {
    throw new CollectError("could not locate the ccusage dependency");
  }
  const rel = typeof bin === "string" ? bin : isObj(bin) ? bin.ccusage : undefined;
  if (typeof rel !== "string") throw new CollectError("could not locate the ccusage binary");
  return path.resolve(path.dirname(pkgPath), rel);
}

export interface RunOptions {
  /** Replaces `[process.execPath, <resolved ccusage bin>]`; the ccusage args are still appended. */
  command?: string[];
  timeoutMs?: number;
  maxBytes?: number;
}

const MAX_BYTES = 64 * 1024 * 1024;

function killTree(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // fall through to a plain kill
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

export function runCcusage(since?: string, opts: RunOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let command: string[];
    const args = ["daily", "--by-agent", "--json"];
    try {
      if (since !== undefined) {
        if (!isIsoDate(since)) throw new CollectError("since must be YYYY-MM-DD");
        args.push("--since", since.replaceAll("-", ""));
      }
      command = opts.command ?? [process.execPath, ccusageBin()];
    } catch (e) {
      return reject(e instanceof CollectError ? e : new CollectError("could not prepare ccusage"));
    }
    const [file, ...head] = command;
    if (file === undefined) return reject(new CollectError("could not start ccusage"));
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? MAX_BYTES;

    const child = spawn(file, [...head, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (kill: boolean, fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) killTree(child);
      child.stdout.destroy();
      child.unref();
      fn();
    };
    const timer = setTimeout(
      () => finish(true, () => reject(new CollectError("ccusage timed out"))),
      timeoutMs,
    );
    child.stdout.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > maxBytes) return finish(true, () => reject(new CollectError("ccusage output too large")));
      chunks.push(c);
    });
    child.on("error", () => finish(false, () => reject(new CollectError("could not start ccusage"))));
    child.on("close", (code) =>
      finish(false, () => {
        if (code !== 0) return reject(new CollectError("ccusage exited with an error"));
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (raw === "") return reject(new CollectError("ccusage produced no output"));
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new CollectError("ccusage output was not valid JSON"));
        }
      }),
    );
  });
}

export async function collect(since?: string): Promise<UsageRecord[]> {
  return toRecords(await runCcusage(since));
}
