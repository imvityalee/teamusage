import { beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { goodReg, INVITE, record } from "./app.fixture.js";
import { openDb, type Db } from "./db.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let token: string;

const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
const upload = (records: unknown[]) => send("/api/usage", { records }, { Authorization: `Bearer ${token}` });

beforeEach(async () => {
  db = openDb(":memory:");
  app = createApp(db, {
    teamForCode: singleTeamCodes(ensureSingleTeam(db), () => INVITE),
    now: () => Date.parse("2026-11-25T10:30:00.000Z"),
  });
  token = ((await (await send("/api/register", goodReg())).json()) as { token: string }).token;
});

test("an upload with a date outside the window is refused whole", async () => {
  const res = await upload([record({ date: "2026-11-25" }), record({ date: "2026-11-27", model: "m2" })]);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "records[1]: date must be from 2024-01-01 to tomorrow" });
  expect(db.prepare("select count(*) as n from usage").get()).toEqual({ n: 0 });
});

test("the first and the last day of the window are stored", async () => {
  const res = await upload([record({ date: "2024-01-01" }), record({ date: "2026-11-26", model: "m2" })]);
  expect(await res.json()).toEqual({ stored: 2, kept: 0 });
});
