import { parseAccountKey } from "@teamusage/shared";
import { t, type Lang, type MessageKey } from "./i18n.js";

/**
 * Display names of account keys (`accountKey` values from the server). Keys are data: they are parsed by the
 * shared `parseAccountKey` and looked up in the fixed map below; the org name is only ever shown as text.
 * Accounts have no colour or icon: agent colours stay the only categorical colours on the page.
 */

const KIND_NAMES = {
  team: "acctTeam",
  enterprise: "acctEnterprise",
  personal: "acctPersonal",
  api: "acctApi",
  unknown: "acctUnknown",
} as const satisfies Record<string, MessageKey>;

/**
 * "Team · Devcats", "Enterprise", "Personal", "API key" or "Unknown" (and the Russian equivalents). A malformed key
 * is "Unknown", never guessed into another kind.
 */
export function accountName(key: string, lang: Lang): string {
  const parsed = parseAccountKey(String(key));
  if (parsed === undefined) return t(lang, KIND_NAMES.unknown);
  const name = t(lang, KIND_NAMES[parsed.kind]);
  return parsed.org ? `${name} · ${parsed.org}` : name;
}
