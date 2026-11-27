import type { Step } from "../migrate.js";

// The new column takes the final name once the old one is dropped. Replacing the column rather than rebuilding `teams`
// keeps the table's id counter and its index on code_hash as they are.
const MEMBERS_OR_ADMINS = `
alter table teams add column access text not null default 'members' check (access in ('members', 'admins'));
update teams set access = 'admins' where dashboard_access = 'admins';
alter table teams drop column dashboard_access;
alter table teams rename column access to dashboard_access;
`;

/** Dashboard access is `members` (was `code`) or `admins`; the column is replaced in place, so `teams` is not rebuilt. */
export const accessValues: Step = (db) => {
  db.exec(MEMBERS_OR_ADMINS);
};
