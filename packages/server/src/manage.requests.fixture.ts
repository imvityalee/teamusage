import { expect } from "vitest";
import { goodReg } from "./app.fixture.js";
import { machineIdOf, postFromPage } from "./hosted.fixture.js";
import { manageWorld, RANGE, T0, usageRowsOf, type ManageWorld } from "./manage.fixture.js";
import { usageCounts } from "./usage-counts.js";

// The requests the management tests send as a browser, a machine and a joining client, and the paced world of the
// removal and deletion tests.

/** The day of `T0`, the day the world's uploads are counted on. */
const TODAY = T0.slice(0, 10);

/** A statistics request over `RANGE` from a browser whose `tu_session` cookie is `session`. */
export const statsAs = async (w: Pick<ManageWorld, "app">, session: string): Promise<Response> =>
  w.app.request(`/api/stats?${RANGE}`, { headers: { Cookie: session } });

/** An upload of `records` as the machine `token`. */
export const uploadAs = (w: Pick<ManageWorld, "app">, token: string, records: unknown[]): Promise<Response> =>
  postFromPage(w.app, "/api/usage", { records }, { Authorization: `Bearer ${token}` });

/** Someone who joins with their machine `one`; a member of the world is one too. */
export type Joiner = { name: string; email: string; one: { id: string; label: string } };

/** Someone who never joined `B`. */
export const NEWCOMER: Joiner = { name: "Uma", email: "uma@example.com", one: { id: machineIdOf(0xc1), label: "uma-laptop" } };

/** The body with which `who`'s installed client registers their machine `one` with `code`. */
export const registration = (who: Joiner, code: string) =>
  goodReg({ inviteCode: code, name: who.name, email: who.email, machineId: who.one.id, machineLabel: who.one.label });

/** Registers `who`'s machine `one` with `code`, as their installed client does when it joins. */
export const registerAs = (w: Pick<ManageWorld, "app">, who: Joiner, code: string): Promise<Response> =>
  postFromPage(w.app, "/api/register", registration(who, code));

export type PacedWorld = ManageWorld & {
  /** The removals' pauses: what the next one runs, which a test sets, and how many there have been. */
  pace: { atPause: (() => Promise<void>) | undefined; pauses: number };
  /** The lines the app logged. */
  logged: string[];
  /** Checks that `B`'s count of usage rows equals the rows it holds. */
  countIsRight: () => void;
};

/** The world of `manageWorld` whose removals take 3 usage rows a slice and pause through `pace`; its errors go to `logged`. */
export async function pacedWorld(): Promise<PacedWorld> {
  const pace: PacedWorld["pace"] = { atPause: undefined, pauses: 0 };
  const logged: string[] = [];
  const pause = async () => {
    pace.pauses++;
    await pace.atPause?.();
  };
  const w = await manageWorld({ removal: { sliceRows: 3, pause }, logError: (line) => logged.push(line) });
  const countIsRight = () => expect(usageCounts(w.db, w.B.id, TODAY).rows).toBe(usageRowsOf(w.db, w.B.id));
  return { ...w, pace, logged, countIsRight };
}
