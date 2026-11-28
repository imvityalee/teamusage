#!/usr/bin/env node
// Fills a team of a local server with worst-case members through the public API (/api/register and /api/usage), for a
// check of the pages in a real browser. It refuses any server that is not local, and never prints the team code.
// Usage: node scripts/seed-worst-case.mjs --server http://localhost:8787 --code <team code> [--members <n>]
import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/** The people, team name, label and login that a layout must survive: the pages' own fixture. */
export const worstCase = JSON.parse(readFileSync(new URL("../packages/server/web/src/site/worst-case.json", import.meta.url), "utf8"));

/** The server's limits the seed reaches; `packages/server/src/seed-worst-case.server.test.ts` pins each to the server's own constant. */
export const LIMITS = Object.freeze({
  membersPerTeam: 2000,
  machinesPerMember: 10,
  tokens: 1e12,
  costUsd: 1e7,
  modelChars: 128,
});

/** Members who register and never upload: the team page lists them as not syncing. */
export const NOT_SYNCING = 14;
/** Fewest members a run makes: the members who never sync and at least one who does. */
export const MIN_MEMBERS = NOT_SYNCING + 1;
const DEFAULT_MEMBERS = 60;
/** Days of usage each syncing member sends, ending today (UTC). */
const DAYS = 30;
/** Longest wait on a Retry-After the seed accepts; a longer one (a day's cap) stops it. */
const MAX_WAIT_S = 120;
/** Times one request is sent again after a 429 with Retry-After. */
const MAX_RETRIES = 5;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const USAGE = "Usage: node scripts/seed-worst-case.mjs --server http://localhost:8787 --code <team code> [--members <n>]";

/** True for `http://localhost` or `http://127.0.0.1` on any port, with no user, path, query or fragment. */
export function isLocalServer(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const bare = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname) && bare;
}

/** The run's settings from the command line; throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const given = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!["--server", "--code", "--members"].includes(flag) || value === undefined || given.has(flag)) throw new Error(USAGE);
    given.set(flag, value);
  }
  const server = given.get("--server");
  const code = given.get("--code");
  if (server === undefined || code === undefined) throw new Error(USAGE);
  if (!isLocalServer(server)) throw new Error("--server must be http://localhost or http://127.0.0.1 (any port): this seed is for a local check");
  const members = Number(given.get("--members") ?? DEFAULT_MEMBERS);
  if (!Number.isInteger(members) || members < MIN_MEMBERS || members > LIMITS.membersPerTeam) {
    throw new Error(`--members must be a whole number from ${MIN_MEMBERS} to ${LIMITS.membersPerTeam}`);
  }
  return { server: new URL(server).origin, code, members };
}

/** The worst-case people, then generated ones, `members` in all; every third generated name is Cyrillic. */
export function peopleOf(members) {
  return Array.from({ length: members }, (_, i) => {
    if (i < worstCase.people.length) return worstCase.people[i];
    const n = i + 1;
    return n % 3 === 0 ? { name: `Участник ${n}`, email: `uchastnik.${n}@example.ru` } : { name: `Member ${n}`, email: `member.${n}@example.com` };
  });
}

/** Member `i`'s machines: the first member holds as many as one member may, each other member one. */
export function machinesOf(i) {
  const count = i === 0 ? LIMITS.machinesPerMember : 1;
  const label = i < worstCase.people.length ? worstCase.machineLabel : `seed-machine-${i + 1}`;
  return Array.from({ length: count }, (_, m) => ({
    id: `5eed${i.toString(16).padStart(20, "0")}${m.toString(16).padStart(8, "0")}`,
    label: m === 0 ? label : `${label}-${m + 1}`,
  }));
}

const record = (date, model, tokens, over = {}) => ({
  date, agent: "claude", model, input: tokens, output: tokens, cacheCreate: tokens, cacheRead: tokens,
  total: 4 * tokens, costUsd: tokens / 1e5, unpriced: false, ...over,
});

const dayBefore = (today, days) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/**
 * What member `i` sends on its first machine: one record a day for `DAYS` days ending `today`, numbers that differ by
 * member; the first member also sends a record at the server's token and cost limits with a model name at its length
 * limit, and the second one a record of zero tokens that has no price.
 */
export function recordsOf(i, today) {
  const records = Array.from({ length: DAYS }, (_, d) => record(dayBefore(today, d), "claude-sonnet-4-5", (i + 1) * 997 + d * 31));
  if (i === 0) records.push(record(today, "m".repeat(LIMITS.modelChars), LIMITS.tokens, { costUsd: LIMITS.costUsd }));
  if (i === 1) records.push(record(today, "claude-unpriced", 0, { costUsd: 0, unpriced: true }));
  return records;
}

/** Sends `body` to `path`; waits out a 429 with a short Retry-After and sends it again; throws on any other refusal. */
async function send(deps, server, path, body, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await deps.fetch(`${server}${path}`, {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
    });
    if (res.ok) return res.json();
    const retryAfter = Number(res.headers.get("retry-after"));
    if (res.status === 429 && retryAfter > 0 && retryAfter <= MAX_WAIT_S && attempt < MAX_RETRIES) {
      deps.log(`the server asked to wait ${retryAfter} s; waiting`);
      await deps.sleep(retryAfter * 1000);
      continue;
    }
    const error = await res.json().then((b) => b?.error, () => undefined);
    throw new Error(`${path} answered ${res.status}${typeof error === "string" ? `: ${error}` : ""}`);
  }
}

/** Registers every member's machines, then uploads the usage of all but the last `NOT_SYNCING`; returns the counts. */
export async function seed({ server, code, members }, deps) {
  const people = peopleOf(members);
  const memberIds = new Set();
  const tokens = [];
  for (const [i, person] of people.entries()) {
    for (const machine of machinesOf(i)) {
      const body = { inviteCode: code, name: person.name, email: person.email, machineId: machine.id, machineLabel: machine.label };
      const answer = await send(deps, server, "/api/register", body);
      memberIds.add(answer.memberId);
      tokens[i] ??= answer.token; // the member's first machine uploads
    }
  }
  let records = 0;
  for (let i = 0; i < members - NOT_SYNCING; i++) {
    const batch = recordsOf(i, deps.today());
    await send(deps, server, "/api/usage", { records: batch }, { Authorization: `Bearer ${tokens[i]}` });
    records += batch.length;
  }
  return { members: memberIds.size, neverSynced: NOT_SYNCING, records };
}

/** Runs the seed with `argv`; returns the exit status. Nothing is sent when the settings are refused. */
export async function main(argv, deps) {
  let settings;
  try {
    settings = parseArgs(argv);
  } catch (err) {
    deps.error(err.message);
    return 1;
  }
  try {
    const made = await seed(settings, deps);
    deps.log(`registered ${made.members} members; ${made.neverSynced} of them never synced; sent ${made.records} usage records`);
    return 0;
  } catch (err) {
    deps.error(`seed stopped: ${err.message}`);
    return 1;
  }
}

const realDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => wait(ms),
  today: () => new Date().toISOString().slice(0, 10),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), realDeps);
}
