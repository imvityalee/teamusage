/**
 * The server's limits that a page names in its own words. A test of each page compares them with the server's
 * (`MAX_ADMINS_AND_VIEWERS` in `src/team-roles.ts`), so that a changed limit fails a test instead of a sentence.
 */

/** Most admins and viewers one team may have. */
export const MAX_ADMINS_AND_VIEWERS = 50;
