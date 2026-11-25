/** The invite code of the route tests' team. */
export const INVITE = "invite-code-123";
/** The machine id `goodReg` registers. */
export const MID = "a".repeat(32);
/** A second machine id, for a member's second machine or another member. */
export const MID2 = "b".repeat(32);

/** A valid `/api/register` body with the fixture invite code. */
export const goodReg = (over: Record<string, unknown> = {}) => ({
  inviteCode: INVITE,
  name: "Ann",
  email: "ann@example.com",
  machineId: MID,
  machineLabel: "mbp",
  ...over,
});

/** A valid usage record of 2026-11-01. */
export const record = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-01",
  agent: "claude",
  model: "m",
  input: 1,
  output: 2,
  cacheCreate: 3,
  cacheRead: 4,
  total: 10,
  costUsd: 0.5,
  unpriced: false,
  ...over,
});
