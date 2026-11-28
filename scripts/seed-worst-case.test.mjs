// Tests for seed-worst-case.mjs against a stub server on this machine. Run with: node --test scripts/seed-worst-case.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isLocalServer, LIMITS, machinesOf, main, NOT_SYNCING, worstCase } from "./seed-worst-case.mjs";

const SCRIPT = fileURLToPath(new URL("./seed-worst-case.mjs", import.meta.url));
const CODE = "c0de".repeat(6);
const TODAY = "2026-11-20";

/** Every request the stub received, and the answers it is told to give first, by path. */
let received = [];
let queued = {};
let stubUrl = "";
const stub = createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => {
    const body = JSON.parse(text);
    received.push({ path: req.url, body, authorization: req.headers.authorization });
    const early = queued[req.url]?.shift();
    if (early) {
      res.writeHead(early.status, { "Content-Type": "application/json", ...early.headers });
      return res.end(JSON.stringify(early.body));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    // One member per email, as the server keeps them; a token per machine.
    if (req.url === "/api/register") return res.end(JSON.stringify({ token: `token-${body.machineId}`, memberId: `m-${body.email}` }));
    res.end(JSON.stringify({ stored: body.records.length, kept: body.records.length }));
  });
});
before(() => new Promise((resolve) => stub.listen(0, "127.0.0.1", () => resolve((stubUrl = `http://127.0.0.1:${stub.address().port}`)))));
after(() => stub.close());

/** Runs the seed in this process with `argv`; returns its exit status, its printed lines and the waits it took. */
async function run(argv, fetchImpl = fetch) {
  received = [];
  const lines = [];
  const waits = [];
  const deps = {
    fetch: fetchImpl,
    sleep: async (ms) => void waits.push(ms),
    today: () => TODAY,
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  const status = await main(argv, deps);
  return { status, lines, waits };
}

const registrations = () => received.filter((r) => r.path === "/api/register").map((r) => r.body);
const uploads = () => received.filter((r) => r.path === "/api/usage");

test("sends the worst-case people, then generated ones up to --members, with the worst-case label", async () => {
  const { status, lines } = await run(["--server", stubUrl, "--code", CODE, "--members", "20"]);
  assert.equal(status, 0);
  const people = [...new Map(registrations().map((r) => [r.email, r.name])).entries()];
  assert.equal(people.length, 20);
  assert.deepEqual(people.slice(0, worstCase.people.length), worstCase.people.map((p) => [p.email, p.name]));
  assert.deepEqual(people.slice(worstCase.people.length, worstCase.people.length + 2), [
    ["uchastnik.6@example.ru", "Участник 6"],
    ["member.7@example.com", "Member 7"],
  ]);
  assert.ok(registrations().every((r) => r.inviteCode === CODE));
  const labels = registrations().map((r) => r.machineLabel);
  assert.equal(labels[0], worstCase.machineLabel);
  assert.ok(labels.includes("seed-machine-20"));
  assert.deepEqual(lines, ["registered 20 members; 14 of them never synced; sent 182 usage records"]);
});

test("the first member holds as many machines as the server allows; the last 14 members never upload", async () => {
  await run(["--server", stubUrl, "--code", CODE, "--members", "20"]);
  const first = registrations().filter((r) => r.email === worstCase.people[0].email);
  assert.equal(first.length, LIMITS.machinesPerMember);
  assert.equal(new Set(first.map((r) => r.machineId)).size, LIMITS.machinesPerMember);
  assert.ok(first.every((r) => /^[a-f0-9]{32}$/.test(r.machineId)));
  const uploaders = uploads().map((u) => u.authorization);
  assert.equal(uploaders.length, 20 - NOT_SYNCING);
  assert.deepEqual(uploaders, Array.from({ length: 6 }, (_, i) => `Bearer token-${machinesOf(i)[0].id}`));
});

test("records stay within the server's limits and its date window, the first member's at the token and cost limits", async () => {
  await run(["--server", stubUrl, "--code", CODE, "--members", "15"]);
  const records = uploads().flatMap((u) => u.body.records);
  assert.ok(records.every((r) => r.date >= "2026-10-22" && r.date <= TODAY));
  assert.ok(records.every((r) => r.total === r.input + r.output + r.cacheCreate + r.cacheRead));
  const top = uploads()[0].body.records.find((r) => r.input === LIMITS.tokens);
  assert.equal(top.costUsd, LIMITS.costUsd);
  assert.equal(top.model.length, LIMITS.modelChars);
});

test("waits out a 429 with Retry-After and sends the same upload again", async () => {
  queued = { "/api/usage": [{ status: 429, headers: { "Retry-After": "7" }, body: { error: "this team is sending too much at once; try again in a minute" } }] };
  const { status, waits } = await run(["--server", stubUrl, "--code", CODE, "--members", "15"]);
  assert.equal(status, 0);
  assert.deepEqual(waits, [7000]);
  assert.deepEqual(uploads()[0].body, uploads()[1].body);
});

test("stops with status 1 and the server's text on a refusal, and never prints the code", async () => {
  queued = { "/api/register": [{ status: 403, headers: {}, body: { error: "invalid invite code" } }] };
  const { status, lines } = await run(["--server", stubUrl, "--code", CODE, "--members", "15"]);
  assert.equal(status, 1);
  assert.deepEqual(lines, ["seed stopped: /api/register answered 403: invalid invite code"]);
  assert.ok(!lines.join("\n").includes(CODE));
});

test("a server that is not local, or settings out of range, exit with status 1 and send nothing", async () => {
  const refused = [
    ["--server", "http://example.com", "--code", CODE],
    ["--server", "https://localhost:8787", "--code", CODE],
    ["--server", "http://localhost.example.com:8787", "--code", CODE],
    ["--server", "http://127.0.0.1.nip.io", "--code", CODE],
    ["--server", "http://user@localhost:8787", "--code", CODE],
    ["--server", "http://localhost:8787/api", "--code", CODE],
    ["--server", stubUrl, "--code", CODE, "--members", String(NOT_SYNCING)],
    ["--server", stubUrl, "--code", CODE, "--members", String(LIMITS.membersPerTeam + 1)],
    ["--server", stubUrl],
  ];
  for (const argv of refused) {
    let calls = 0;
    const { status } = await run(argv, async () => void calls++);
    assert.equal(status, 1, argv.join(" "));
    assert.equal(calls, 0, argv.join(" "));
  }
});

test("run as a command, a non-local server exits with status 1 before any request", () => {
  const ran = spawnSync(process.execPath, [SCRIPT, "--server", "http://192.0.2.1:8787", "--code", CODE], { encoding: "utf8", timeout: 10_000 });
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /--server must be http:\/\/localhost or http:\/\/127\.0\.0\.1/);
  assert.ok(!ran.stderr.includes(CODE) && !ran.stdout.includes(CODE));
});

test("only localhost and 127.0.0.1 over http count as local, on any port", () => {
  for (const url of ["http://localhost", "http://localhost:8787", "http://127.0.0.1:9000/"]) assert.equal(isLocalServer(url), true, url);
  for (const url of ["http://[::1]:8787", "http://0.0.0.0:8787", "file:///tmp", "not a url"]) assert.equal(isLocalServer(url), false, url);
});
