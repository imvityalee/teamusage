import { describe, expect, test } from "vitest";
import * as selfHosted from "./app.harness.js";
import { record } from "./app.fixture.js";
import { hostedApp, hostedTeam, machineClient, mid, testLimits } from "./hosted.fixture.js";
import type { TeamLimits } from "./team-limits.js";

// The app's clock is on 2026-11-26: 2024-06-01 lies inside the upload window and before the oldest date a hosted team keeps.
const NOW = Date.parse("2026-11-26T10:30:00.000Z");
const BATCH = [record({ date: "2024-06-01" }), record({ date: "2026-11-25", model: "m2" })];

const caps = (): TeamLimits => ({
  membersPerTeam: 5, machinesPerMember: 6, rowsPerMachine: 1000, rowsPerTeam: 1001, rowsAddedPerDay: 1002, storageLow: () => false,
});

test("a hosted team's upload stores the current record and counts the old one as kept", async () => {
  const { db, app } = hostedApp({ limits: testLimits(caps(), { usageDaysKept: 730 }), now: () => NOW });
  const { code } = hostedTeam(db, { githubId: 1, login: "ann" }, "code");
  const { join, upload } = machineClient(() => app, () => code);
  const res = await upload(await join({ machineId: mid(1) }), BATCH);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ stored: 1, kept: 1 });
});

describe("a self-hosted server", () => {
  selfHosted.useFreshApp();

  test("stores the old record too", async () => {
    const { token } = await selfHosted.register();
    const res = await selfHosted.post("/api/usage", { records: BATCH }, selfHosted.bearer(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 2, kept: 0 });
  });
});
