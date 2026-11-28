import { describe, expect, test } from "vitest";
import { MAX_REMOVAL_IDS } from "../../../src/routes-team-members.js";
import type { ApiResult } from "../site/http.js";
import type { RemovalAnswer } from "./api.js";
import { MAX_TICKED, type MemberRow } from "./members.js";
import { machine, member, rowsOf, TODAY, worstCase } from "./members.fixture.js";
import { syncText } from "./members-text.js";
import { MAX_REMOVAL, removalBody, removalOutcome, removalSummary, removedText, type RemovalTarget } from "./removal.js";

const row = (...args: Parameters<typeof member>): MemberRow => rowsOf([member(...args)])[0] as MemberRow;
const nurlan = (machines = [machine("2026-10-17")]) => row(7, machines, { name: "Nurlan Asanov", email: "nurlan.asanov@acme.example" });
const people = (n: number): MemberRow[] => rowsOf(Array.from({ length: n }, (_, i) => member(100 + i, [machine(TODAY)], { name: `Person ${i + 1}` })));
const several = (n: number): RemovalTarget => ({ members: people(n), machines: [] });
const oneMachine = (who = nurlan()): RemovalTarget => ({ members: [], machines: [{ member: who, machine: who.machines[0]! }] });

describe("removalBody", () => {
  test("one member", () => {
    expect(removalBody({ members: [nurlan()], machines: [] }, true)).toEqual({ members: [7], machines: [], rotateCode: true });
  });

  test("500 members, and no more", () => {
    expect(removalBody(several(500), true).members).toHaveLength(500);
    expect(() => removalBody(several(501), true)).toThrow(RangeError);
  });

  test("one machine, with the box unticked", () => {
    const target = oneMachine();
    expect(removalBody(target, false)).toEqual({ members: [], machines: [target.machines[0]!.machine.id], rotateCode: false });
  });

  test("a member and a machine of another member together", () => {
    const [a, b] = people(2) as [MemberRow, MemberRow];
    expect(removalBody({ members: [a], machines: [{ member: b, machine: b.machines[0]! }] }, true)).toEqual({ members: [a.id], machines: [b.machines[0]!.id], rotateCode: true });
  });

  test("a machine of a member who is also named is not sent twice", () => {
    const [a, b] = people(2) as [MemberRow, MemberRow];
    const target = { members: [a, b], machines: [{ member: a, machine: a.machines[0]! }] };
    expect(removalBody(target, true)).toEqual({ members: [a.id, b.id], machines: [], rotateCode: true });
  });

  test("the page's limit is the server's and the card's", () => {
    expect(MAX_REMOVAL).toBe(MAX_REMOVAL_IDS);
    expect(MAX_TICKED).toBe(MAX_REMOVAL);
  });
});

describe("removalOutcome", () => {
  const ok = (value: RemovalAnswer): ApiResult<RemovalAnswer> => ({ kind: "ok", value });
  const refused = (status: number, error: string): ApiResult<RemovalAnswer> => ({ kind: "refused", status, error });

  test.each<[string, ApiResult<RemovalAnswer>, unknown]>([
    ["200 with a code", ok({ removed: { members: 1, machines: 1 }, code: "c0de" }), { kind: "done", removed: { members: 1, machines: 1 }, code: "c0de" }],
    ["200 without a code", ok({ removed: { members: 0, machines: 1 } }), { kind: "done", removed: { members: 0, machines: 1 }, code: null }],
    ["200 the page cannot read", ok({} as RemovalAnswer), { kind: "stopped", role: false, codeKept: false }],
    ["400", refused(400, "nothing to remove"), { kind: "notSent", error: null }],
    ["401", { kind: "unauthorized" }, { kind: "signedOut" }],
    ["403 of a role", refused(403, "your role does not allow this"), { kind: "stopped", role: true, codeKept: true }],
    ["403 of another site", refused(403, "cross-site request refused"), { kind: "notSent", error: "cross-site request refused" }],
    ["413", refused(413, "payload too large"), { kind: "notSent", error: "payload too large" }],
    ["404", refused(404, "team not found"), { kind: "stopped", role: false, codeKept: true }],
    ["500", { kind: "failed" }, { kind: "stopped", role: false, codeKept: false }],
    ["503 of a proxy", refused(503, ""), { kind: "stopped", role: false, codeKept: false }],
    ["a network error", { kind: "network" }, { kind: "stopped", role: false, codeKept: false }],
  ])("%s", (_name, result, outcome) => {
    expect(removalOutcome(result)).toEqual(outcome);
  });
});

describe("removalSummary", () => {
  test("one member with one machine: name, email, the machine and the last sync in the card's words", () => {
    expect(removalSummary({ members: [nurlan()], machines: [] }, "en", TODAY)).toEqual({
      title: "Remove Nurlan Asanov?",
      detail: `nurlan.asanov@acme.example, 1 machine, last sync ${syncText("en", 41)}`,
    });
    expect(syncText("en", 41)).toBe("41 days ago");
  });

  test("one member with three machines: the newest sync", () => {
    const who = nurlan([machine("2026-10-17"), machine(TODAY), machine(null)]);
    expect(removalSummary({ members: [who], machines: [] }, "en", TODAY).detail).toBe("nurlan.asanov@acme.example, 3 machines, last sync today");
  });

  test("the day is the one given: a day later the sync is a day older", () => {
    expect(removalSummary({ members: [nurlan()], machines: [] }, "en", "2026-11-28").detail).toContain("last sync 42 days ago");
  });

  test("one member in Russian, and a member who never synced", () => {
    expect(removalSummary({ members: [nurlan()], machines: [] }, "ru", TODAY)).toEqual({
      title: "Удалить участника Nurlan Asanov?",
      detail: "nurlan.asanov@acme.example, 1 устройство, последняя отправка: 41 день назад",
    });
    expect(removalSummary({ members: [nurlan([machine(null)])], machines: [] }, "en", TODAY).detail).toBe("nurlan.asanov@acme.example, 1 machine, last sync never");
  });

  test.each([
    [2, "Remove 2 members?", "Person 1, Person 2. 2 machines."],
    [4, "Remove 4 members?", "Person 1, Person 2, Person 3 and 1 more. 4 machines."],
    [5, "Remove 5 members?", "Person 1, Person 2, Person 3 and 2 more. 5 machines."],
    [21, "Remove 21 members?", "Person 1, Person 2, Person 3 and 18 more. 21 machines."],
  ])("%i members in English", (n, title, detail) => {
    expect(removalSummary(several(n), "en", TODAY)).toEqual({ title, detail });
  });

  test.each([
    [2, "Удалить 2 участников?", "Person 1, Person 2. 2 устройства."],
    [4, "Удалить 4 участников?", "Person 1, Person 2, Person 3 и ещё 1. 4 устройства."],
    [5, "Удалить 5 участников?", "Person 1, Person 2, Person 3 и ещё 2. 5 устройств."],
    [21, "Удалить 21 участника?", "Person 1, Person 2, Person 3 и ещё 18. 21 устройство."],
  ])("%i members in Russian", (n, title, detail) => {
    expect(removalSummary(several(n), "ru", TODAY)).toEqual({ title, detail });
  });

  test("a machine: its label, and whose it is", () => {
    const who = nurlan([machine(TODAY, "work-laptop")]);
    expect(removalSummary(oneMachine(who), "en", TODAY)).toEqual({
      title: "Remove the machine work-laptop?",
      detail: "Nurlan Asanov's machine. Its usage history is deleted and the browser signed in from it is signed out.",
    });
    expect(removalSummary(oneMachine(who), "ru", TODAY).title).toBe("Удалить устройство work-laptop?");
  });

  test("worst-case names, emails and labels are whole", () => {
    const [long, , , longest, emoji] = worstCase.people;
    const who = row(9, [machine(TODAY, worstCase.machineLabel)], longest);
    const one = removalSummary({ members: [who], machines: [] }, "ru", TODAY);
    expect(one.title).toContain(longest!.name);
    expect(one.detail).toContain(longest!.email);
    const machineSummary = removalSummary(oneMachine(who), "en", TODAY);
    expect(machineSummary.title).toContain(worstCase.machineLabel);
    expect(machineSummary.detail).toContain(longest!.name);
    const many = rowsOf(worstCase.people.map((p, i) => member(i + 1, [machine(TODAY)], p)));
    expect(removalSummary({ members: many, machines: [] }, "en", TODAY).detail).toBe(`${long!.name}, Jo, Данияр Жумабеков and 2 more. 5 machines.`);
    expect(removalSummary({ members: [rowsOf([member(1, [], emoji)])[0]!], machines: [] }, "en", TODAY).title).toBe(`Remove ${emoji!.name}?`);
  });
});

describe("removedText", () => {
  const one = { members: [nurlan()], machines: [] };

  test("what the server answered, without the machines that went with their members", () => {
    expect(removedText("en", { members: 1, machines: 1 }, one)).toBe("Removed 1 member.");
    const target = { members: people(14), machines: [oneMachine().machines[0]!, oneMachine(row(8, [machine(TODAY)])).machines[0]!] };
    expect(removedText("en", { members: 14, machines: 16 }, target)).toBe("Removed 14 members and 2 machines.");
    expect(removedText("en", { members: 0, machines: 1 }, oneMachine())).toBe("Removed 1 machine.");
  });

  test.each([
    [1, "Удалили 1 участника."],
    [2, "Удалили 2 участников."],
    [5, "Удалили 5 участников."],
    [21, "Удалили 21 участника."],
  ])("%i members in Russian", (n, text) => {
    expect(removedText("ru", { members: n, machines: n }, several(n))).toBe(text);
  });

  test("a run again that found nothing left", () => {
    expect(removedText("en", { members: 0, machines: 0 }, one)).toBe("Nothing was left to remove.");
    expect(removedText("ru", { members: 0, machines: 0 }, one)).toBe("Удалять было уже нечего.");
  });
});
