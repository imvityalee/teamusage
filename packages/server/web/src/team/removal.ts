import type { Lang } from "../lang.js";
import type { ApiResult } from "../site/http.js";
import { daysSince } from "../site/sync-age.js";
import type { RemovalAnswer, RemovalBody } from "./api.js";
import type { Removal } from "./members-card.js";
import { countText, syncText } from "./members-text.js";
import { tt } from "./strings.js";

/** What a removal of members and machines decides, with no page in it: the body it sends, what its answer means, and its words. */

/** Whole members, and machines of members: what a removal button chose. */
export type RemovalTarget = Removal;

/** Most members, and most machines, one removal names (`MAX_REMOVAL_IDS` of the server, which a test compares). */
export const MAX_REMOVAL = 500;

/** The server's refusal of a role that may not remove (`src/team-access.ts`). */
const ROLE_NOT_ALLOWED = "your role does not allow this";

export type RemovalOutcome =
  | { kind: "done"; removed: RemovalAnswer["removed"]; code: string | null }
  | { kind: "signedOut" }
  /** Refused before anything was removed: a 400 (`error` null), or another refusal of the request itself (its text). */
  | { kind: "notSent"; error: string | null }
  /**
   * Part of the usage may be gone. `lost`: what the server said the person lost midway, a 403 (`role`: the role no
   * longer allows it) or a 404 (`access`: no role in the team, or no team), after which a run again cannot work.
   * `codeKept`: the server itself stopped it before its last step, so the members are still there and the code was not
   * replaced; after a 5xx, the network or an answer the page cannot read, the removal may have finished unheard.
   */
  | { kind: "stopped"; lost: "role" | "access" | null; codeKept: boolean };

/** What the page around the dialog learns of a finished removal: the counts, and whether the code was replaced, never the code. */
export type RemovalDone = { kind: "done"; removed: RemovalAnswer["removed"]; replaced: boolean };

/** The machines named on their own: those whose member is not removed whole. */
const loneMachines = (target: RemovalTarget) => {
  const whole = new Set(target.members.map((m) => m.id));
  return target.machines.filter(({ member }) => !whole.has(member.id));
};

/** The request for `target`; `replaceCode` is the box as it stands. Throws a RangeError for more than MAX_REMOVAL of either. */
export function removalBody(target: RemovalTarget, replaceCode: boolean): RemovalBody {
  const members = target.members.map((m) => m.id);
  const machines = loneMachines(target).map(({ machine }) => machine.id);
  if (members.length > MAX_REMOVAL || machines.length > MAX_REMOVAL) throw new RangeError(`one removal names at most ${MAX_REMOVAL} members and ${MAX_REMOVAL} machines`);
  return { members, machines, rotateCode: replaceCode };
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

const isAnswer = (v: unknown): v is RemovalAnswer => {
  const { removed, code } = (v ?? {}) as Partial<Record<keyof RemovalAnswer, unknown>>;
  const counts = (removed ?? {}) as Record<string, unknown>;
  return isCount(counts.members) && isCount(counts.machines) && (code === undefined || typeof code === "string");
};

const UNSURE = { kind: "stopped", lost: null, codeKept: false } as const;

/** What an answer of `POST …/removals` means for the dialog (the answers of `src/routes-team-members.ts`). */
export function removalOutcome(result: ApiResult<RemovalAnswer>): RemovalOutcome {
  switch (result.kind) {
    case "ok":
      return isAnswer(result.value) ? { kind: "done", removed: result.value.removed, code: result.value.code ?? null } : UNSURE;
    case "unauthorized":
      return { kind: "signedOut" };
    case "refused":
      if (result.status === 403 && result.error === ROLE_NOT_ALLOWED) return { kind: "stopped", lost: "role", codeKept: true };
      if (result.status === 404) return { kind: "stopped", lost: "access", codeKept: true };
      if (result.status === 400) return { kind: "notSent", error: null };
      return result.status < 500 ? { kind: "notSent", error: result.error } : UNSURE;
    default:
      return UNSURE;
  }
}

/** How many names the line under the heading shows before "and 11 more". */
const NAMES_SHOWN = 3;

const machineCount = (target: RemovalTarget): number => target.members.reduce((n, m) => n + m.machines.length, 0) + loneMachines(target).length;

/** One member's email, machines and last sync; "no machines" for a member who has none, "never synced" for one who never did. */
function oneDetail(lang: Lang, one: RemovalTarget["members"][number], machines: string, today: string): string {
  if (one.machines.length === 0) return tt(lang, "removeOneDetailNone", { email: one.email });
  const days = daysSince(one.lastSyncAt, today);
  return days === null ? tt(lang, "removeOneDetailNever", { email: one.email, machines }) : tt(lang, "removeOneDetail", { email: one.email, machines, sync: syncText(lang, days) });
}

/** "A", "A and B", "A, B and C": at most NAMES_SHOWN names. */
function namesText(lang: Lang, names: string[]): string {
  const [a = "", b = "", c = ""] = names;
  if (names.length === 2) return tt(lang, "namesTwo", { a, b });
  return names.length === 3 ? tt(lang, "namesThree", { a, b, c }) : a;
}

/** Which words a target takes: one member, one machine, or several (members ticked together, or anything else). */
export type TargetKind = "one" | "machine" | "several";

export function targetKind(target: RemovalTarget): TargetKind {
  if (target.members.length === 0 && target.machines.length === 1) return "machine";
  return target.members.length === 1 && target.machines.length === 0 ? "one" : "several";
}

/** The dialog's heading and the line under it, for one member, several, or one machine. */
export function removalSummary(target: RemovalTarget, lang: Lang, today: string): { title: string; detail: string } {
  const machines = countText(lang, "machineCount", machineCount(target));
  const kind = targetKind(target);
  if (kind === "machine") {
    const { member, machine } = target.machines[0]!;
    return { title: tt(lang, "removeMachineTitle", { label: machine.label }), detail: tt(lang, "removeMachineDetail", { name: member.name }) };
  }
  if (kind === "one") {
    const one = target.members[0]!;
    return { title: tt(lang, "removeOneTitle", { name: one.name }), detail: oneDetail(lang, one, machines, today) };
  }
  const rest = target.members.length - NAMES_SHOWN;
  const detail =
    rest > 0
      ? tt(lang, "removeSeveralDetailMore", { names: target.members.slice(0, NAMES_SHOWN).map((m) => m.name).join(", "), more: countText(lang, "removeMore", rest), machines })
      : tt(lang, "removeSeveralDetail", { names: namesText(lang, target.members.map((m) => m.name)), machines });
  return { title: tt(lang, "removeSeveralTitle", { members: countText(lang, "membersAcc", target.members.length) }), detail };
}

/**
 * "Removed 14 members and 2 machines.": what the server answered. The machines that went with their members are not
 * counted again: only those named on their own.
 */
export function removedText(lang: Lang, removed: RemovalAnswer["removed"], target: RemovalTarget): string {
  const machines = Math.min(removed.machines, loneMachines(target).length);
  const vars = { members: countText(lang, "membersAcc", removed.members), machines: countText(lang, "machineCount", machines) };
  if (removed.members > 0) return tt(lang, machines > 0 ? "removedBoth" : "removedMembers", vars);
  return tt(lang, machines > 0 ? "removedMachines" : "removedNone", vars);
}
