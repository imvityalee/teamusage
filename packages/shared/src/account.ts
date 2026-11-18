import { NAME_CONTROL_CHARS } from "./records.js";

export type AccountKind = "personal" | "team" | "enterprise" | "api";
export interface AccountLabel {
  kind: AccountKind;
  org?: string;
}

/** Organisation name bound, in UTF-16 code units. */
export const MAX_ORG_CHARS = 100;
/** Most `account=` values one stats request accepts. */
export const MAX_ACCOUNTS = 50;

const KINDS: readonly AccountKind[] = ["personal", "team", "enterprise", "api"];
const WITH_ORG: readonly AccountKind[] = ["team", "enterprise"];

/** Filter key: `team:<org>`, `enterprise:<org>`, `personal`, `api`, or `unknown` for no label. */
export function accountKey(a: AccountLabel | null | undefined): string {
  if (!a) return "unknown";
  return WITH_ORG.includes(a.kind) ? `${a.kind}:${a.org ?? ""}` : a.kind;
}

/** Inverse of accountKey, splitting on the first colon. `undefined` when malformed. */
export function parseAccountKey(key: string): { kind: AccountKind | "unknown"; org: string | null } | undefined {
  if (key === "unknown") return { kind: "unknown", org: null };
  if (key === "personal" || key === "api") return { kind: key, org: null };
  const i = key.indexOf(":");
  if (i < 0) return undefined;
  const kind = key.slice(0, i);
  const org = key.slice(i + 1);
  if (kind !== "team" && kind !== "enterprise") return undefined;
  if (org.length > MAX_ORG_CHARS || NAME_CONTROL_CHARS.test(org)) return undefined;
  return { kind, org };
}

/** Validates an uploaded account label; extra keys are dropped. A string result is the error. */
export function validateAccount(raw: unknown): AccountLabel | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "invalid account";
  const { kind, org } = raw as Record<string, unknown>;
  if (typeof kind !== "string" || !KINDS.includes(kind as AccountKind)) return "invalid account kind";
  if (org === undefined) return { kind: kind as AccountKind };
  if (!WITH_ORG.includes(kind as AccountKind)) return "org is not allowed for this account kind";
  if (typeof org !== "string" || org.length > MAX_ORG_CHARS || NAME_CONTROL_CHARS.test(org)) {
    return "invalid account org";
  }
  return { kind: kind as AccountKind, org };
}
