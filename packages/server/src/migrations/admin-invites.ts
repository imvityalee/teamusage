import type { Step } from "../migrate.js";

// An invite waiting to be accepted, stored as the hash of its token; an accepted or cancelled invite is deleted, and an
// invite goes with its team.
const ADMIN_INVITES = `
create table admin_invites (
  id text primary key,
  team_id integer not null references teams(id) on delete cascade,
  role text not null check (role in ('admin', 'viewer')),
  token_hash text not null unique,
  created_at text not null,
  expires_at text not null
);
create index admin_invites_team on admin_invites (team_id);
`;

/** Adds the invites with which a team's owner makes someone an admin or a viewer. */
export const adminInvites: Step = (db) => {
  db.exec(ADMIN_INVITES);
};
