import { translator, type Table } from "../site/i18n.js";
import * as code from "./strings/code.js";
import * as invite from "./strings/invite.js";
import * as page from "./strings/page.js";
import * as settings from "./strings/settings.js";

/**
 * Everything `/team` says, in English (the frame's also in team.html) and Russian: one table, assembled from the part of
 * each card (`strings/<part>.ts`). A card adds its part here.
 */
export const parts = { page, code, invite, settings };

const en = { ...page.en, ...code.en, ...invite.en, ...settings.en };

export type TeamKey = keyof typeof en;

const ru: Record<TeamKey, string> = { ...page.ru, ...code.ru, ...invite.ru, ...settings.ru };

export const strings: Table<TeamKey> = { en, ru };

export const tt = translator(strings);
