import type { UsageRecord } from "@teamusage/shared";
import type { TeamData } from "./team-data.js";

/** A registration of `machineId` for member A <a@example.com>. */
export const reg = (machineId: string, over: Partial<Parameters<TeamData["registerMachine"]>[0]> = {}) => ({
  name: "A",
  email: "a@example.com",
  machineId,
  machineLabel: "mbp",
  ...over,
});

/** A usage record of 2026-11-01 with 10 tokens. */
export const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  date: "2026-11-01",
  agent: "claude",
  model: "opus",
  input: 10,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  total: 10,
  costUsd: 1,
  unpriced: false,
  ...over,
});

/** `n` records with models `m<from>` onward. */
export const rows = (n: number, from = 0): UsageRecord[] => Array.from({ length: n }, (_, i) => rec({ model: `m${from + i}` }));
