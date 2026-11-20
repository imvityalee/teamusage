import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SYNC_ERRORS, type SyncErrorReason } from "./errors.js";

/**
 * The plugins' skills tell the user what each sync error means and how to fix it, quoting the message. A message the
 * skills do not know falls through to a generic answer, so every one the skill's tool can return must be listed.
 */
const SKILLS: Record<string, readonly SyncErrorReason[]> = {
  "usage-sync": Object.keys(SYNC_ERRORS) as SyncErrorReason[],
  // get_my_usage and get_team_usage check the config and the token binding, and never register or take the lock.
  "usage-stats": ["notSetUp", "tokenUnbound", "identityChanged"],
};

/** The message as the skills quote it: its first clause, without "so nothing was sent" or the setup hint. */
const quoted = (reason: SyncErrorReason) => SYNC_ERRORS[reason].split(/[;,]/)[0] as string;

describe.each(["plugin", "codex-plugin"])("%s skills", (plugin) => {
  test.each(Object.entries(SKILLS))("%s explains every sync error its tool can return", (skill, reasons) => {
    const text = readFileSync(new URL(`../../../${plugin}/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
    for (const reason of reasons) expect(text, reason).toContain(quoted(reason));
  });
});
