import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { goodReg, INVITE, MID } from "./app.fixture.js";
import { db, post, register, useFreshApp } from "./app.harness.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

useFreshApp();

describe("POST /api/register", () => {
  test("happy path returns token and memberId", async () => {
    const res = await post("/api/register", goodReg());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; memberId: number };
    expect(body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof body.memberId).toBe("number");
  });

  test("wrong invite code -> 403", async () => {
    const res = await post("/api/register", goodReg({ inviteCode: "nope" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid invite code" });
  });

  test("invite code of a different length or non-string -> 403 without throwing", async () => {
    expect((await post("/api/register", goodReg({ inviteCode: "" }))).status).toBe(403);
    expect((await post("/api/register", goodReg({ inviteCode: INVITE + "x" }))).status).toBe(403);
    expect((await post("/api/register", goodReg({ inviteCode: 5 }))).status).toBe(403);
  });

  test("invite code is read on each request (rotation takes effect)", async () => {
    let code = "one";
    const a = createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => code) });
    const send = (c: string) =>
      a.request("/api/register", {
        method: "POST",
        body: JSON.stringify(goodReg({ inviteCode: c })),
        headers: { "Content-Type": "application/json" },
      });
    expect((await send("one")).status).toBe(200);
    code = "two";
    expect((await send("one")).status).toBe(403);
    expect((await send("two")).status).toBe(200);
  });

  test.each([
    ["missing email", { email: undefined }],
    ["email without @", { email: "annexample.com" }],
    ["email over 254 chars", { email: "a".repeat(250) + "@b.co" }],
    ["empty name", { name: "   " }],
    ["name over 100 chars", { name: "n".repeat(101) }],
    ["non-string name", { name: 5 }],
    ["short machineId", { machineId: "abc" }],
    ["uppercase machineId", { machineId: "A".repeat(32) }],
    ["machineId with newline", { machineId: MID + "\n" }],
    ["empty machineLabel", { machineLabel: " " }],
    ["machineLabel over 100 chars", { machineLabel: "l".repeat(101) }],
  ])("invalid input (%s) -> 400 and nothing stored", async (_n, over) => {
    const res = await post("/api/register", goodReg(over));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(db.prepare("select count(*) as n from members").get()).toEqual({ n: 0 });
  });

  test("validation runs only after the invite check (bad invite + bad input -> 403)", async () => {
    const res = await post("/api/register", goodReg({ inviteCode: "nope", email: "x" }));
    expect(res.status).toBe(403);
  });

  test("malformed JSON -> 400, not 500", async () => {
    const res = await post("/api/register", "{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  test("non-object JSON body -> 400", async () => {
    expect((await post("/api/register", "null")).status).toBe(400);
    expect((await post("/api/register", "[1]")).status).toBe(400);
  });

  test("machine owned by another member -> 409 without echoing details", async () => {
    await register();
    const res = await post("/api/register", goodReg({ email: "bob@example.com", name: "Bob" }));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "machine already registered to another member" });
    expect(text).not.toContain(MID);
  });

  test("re-registering the same machine for the same member succeeds", async () => {
    await register();
    expect((await post("/api/register", goodReg())).status).toBe(200);
  });
});


describe("POST /api/register input hygiene", () => {
  test("control characters in name or machineLabel are 400", async () => {
    for (const bad of ["a\nb", "a\x00b", "a\x7fb", "a\tb", "\x1bx"]) {
      expect((await post("/api/register", goodReg({ name: bad }))).status).toBe(400);
      expect((await post("/api/register", goodReg({ machineLabel: bad }))).status).toBe(400);
    }
    expect((await post("/api/register", goodReg())).status).toBe(200);
  });
});

