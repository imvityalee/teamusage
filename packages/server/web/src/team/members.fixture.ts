import { noon } from "../site/noon.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import type { ApiMember, Machine } from "./api.js";
import { toRows, type MemberRow } from "./members.js";

/** Members of a team for the tests (tests only). Times are noon on a local day, so a day count is the same in every time zone. */

export const TODAY = "2026-11-27";

const hex = (n: number) => n.toString(16).padStart(32, "0");
let serial = 0;

/** A machine that last synced on `day` (a local day), or never. */
export const machine = (day: string | null, label?: string): Machine => {
  const id = ++serial;
  return { id: hex(id + 1_000_000), label: label ?? `machine-${id}`, lastSyncAt: day === null ? null : noon(day) };
};

export const member = (id: number, machines: Machine[], over: Partial<ApiMember> = {}): ApiMember => ({
  id,
  name: `Member ${id}`,
  email: `member${id}@acme.example`,
  joinedAt: "2026-09-02T12:00:00.000Z",
  machines,
  ...over,
});

/** `count` members: the first `stale` have not synced for 41 days; the rest synced today. */
export function team(count: number, stale = 0): ApiMember[] {
  return Array.from({ length: count }, (_, i) =>
    member(i + 1, [machine(i < stale ? "2026-10-17" : TODAY)], { name: `Person ${String(i + 1).padStart(4, "0")}` }),
  );
}

export const rowsOf = (members: ApiMember[]): MemberRow[] => toRows(members, TODAY);

export { worstCase };
