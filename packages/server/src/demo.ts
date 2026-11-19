import type { AccountLabel, UsageRecord } from "@teamusage/shared";
import { registerMachine, upsertUsage, type Db } from "./db.js";

const DAYS = 180;
const DAY_MS = 86_400_000;
const WEEKEND_FACTOR = 0.15;
const EMPTY_DAY_RATE = 0.12;

/** Small seeded PRNG (mulberry32): the same seed always yields the same sequence. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS: Record<string, { model: string; usdPerMTok: number }[]> = {
  claude: [
    { model: "claude-sonnet-4-5", usdPerMTok: 1.2 },
    { model: "claude-opus-4-1", usdPerMTok: 5.5 },
    { model: "claude-haiku-4-5", usdPerMTok: 0.4 },
  ],
  codex: [
    { model: "gpt-5-codex", usdPerMTok: 0.9 },
    { model: "gpt-5", usdPerMTok: 1.0 },
  ],
  gemini: [
    { model: "gemini-2.5-pro", usdPerMTok: 0.8 },
    { model: "gemini-2.5-flash", usdPerMTok: 0.15 },
  ],
  opencode: [
    { model: "qwen3-coder", usdPerMTok: 0.3 },
    { model: "deepseek-v3", usdPerMTok: 0.25 },
  ],
};

/** Account labels per member and agent; an agent without an entry uploads unlabelled rows. */
type Labels = Partial<Record<string, AccountLabel>>;

const MEMBERS: { name: string; email: string; agents: string[]; scale: number; labels: Labels }[] = [
  {
    name: "Alice Archer",
    email: "alice@example.com",
    agents: ["claude", "codex"],
    scale: 1.6,
    labels: { claude: { kind: "team", org: "Acme", plan: "team_premium" }, codex: { kind: "personal", plan: "plus" } },
  },
  { name: "Bao Nguyen", email: "bao@example.com", agents: ["claude", "gemini"], scale: 1.2, labels: { claude: { kind: "team", org: "Acme", plan: "team_standard" } } },
  { name: "Carla Mendes", email: "carla@example.com", agents: ["codex", "opencode"], scale: 1.0, labels: { codex: { kind: "team", plan: "business" } } },
  { name: "Dmitri Volkov", email: "dmitri@example.com", agents: ["claude", "opencode", "gemini"], scale: 0.8, labels: { claude: { kind: "personal", plan: "max_5x" } } },
  { name: "Esi Boateng", email: "esi@example.com", agents: ["gemini", "codex"], scale: 0.5, labels: {} },
  { name: "Farid Karimi", email: "farid@example.com", agents: ["claude"], scale: 0.3, labels: { claude: { kind: "personal" } } },
];

/**
 * Fills the database with deterministic made-up usage: 6 members, 4 agents, 180 days ending at `today`, some with Claude and Codex account labels and plans.
 * No real time or `Math.random`; rows go through the same write paths as real data.
 */
export function seedDemo(db: Db, today: string): void {
  const rand = prng(20260818);
  const end = Date.parse(`${today}T00:00:00Z`);
  MEMBERS.forEach((m) => {
    const machineId = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join("");
    const who = registerMachine(db, { name: m.name, email: m.email, machineId, machineLabel: `${m.name.split(" ")[0]}'s laptop` });
    const records: UsageRecord[] = [];
    for (let d = DAYS - 1; d >= 0; d--) {
      const day = new Date(end - d * DAY_MS);
      const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
      if (rand() < EMPTY_DAY_RATE) continue;
      const volume = (weekend ? WEEKEND_FACTOR : 1) * m.scale * (0.5 + rand());
      let wrote = 0;
      m.agents.forEach((agent, k) => {
        // A day that is not empty always has at least one record.
        if (rand() < 0.2 && !(k === m.agents.length - 1 && wrote === 0)) return;
        wrote++;
        const choices = MODELS[agent] as { model: string; usdPerMTok: number }[];
        const pick = choices[Math.floor(rand() * choices.length)] as { model: string; usdPerMTok: number };
        const input = Math.round(volume * (20_000 + rand() * 120_000));
        const output = Math.round(volume * (5_000 + rand() * 40_000));
        const cacheCreate = Math.round(volume * (30_000 + rand() * 250_000));
        const cacheRead = Math.round(volume * (200_000 + rand() * 2_500_000));
        const total = input + output + cacheCreate + cacheRead;
        records.push({
          date: day.toISOString().slice(0, 10),
          agent,
          model: pick.model,
          input,
          output,
          cacheCreate,
          cacheRead,
          total,
          costUsd: Math.round((total / 1e6) * pick.usdPerMTok * 1e4) / 1e4,
          unpriced: false,
          ...(m.labels[agent] ? { account: m.labels[agent] } : {}),
        });
      });
    }
    upsertUsage(db, { memberId: who.memberId, machineId }, records);
  });
  // upsertUsage stamps the real clock; the demo must not depend on it.
  db.prepare("update machines set last_sync_at = ?").run(`${today}T12:00:00.000Z`);
}
