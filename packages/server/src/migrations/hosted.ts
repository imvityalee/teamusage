import type { Step } from "../migrate.js";

// A hosted team's code is kept as a hash, which finds the team, and sealed; the team of a self-hosted server leaves
// both null and keeps its code where it is.
const TEAM_CODES = `
alter table teams add column code_hash text;
alter table teams add column code_sealed text;
create unique index teams_code_hash on teams (code_hash) where code_hash is not null;
`;

const USERS_AND_ROLES = `
create table users (
  id integer primary key autoincrement,
  github_id integer not null unique,
  login text not null,
  created_at text not null
);
create table team_roles (
  team_id integer not null references teams(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'viewer')),
  created_at text not null,
  primary key (team_id, user_id)
);
create unique index team_roles_one_owner on team_roles (team_id) where role = 'owner';
create index team_roles_user on team_roles (user_id);
`;

// The table is built under a `_new` name and takes the final name once the old one, and its index, are dropped.
const SESSIONS_OF_TWO_KINDS = `
create table sessions_new (
  id text primary key,
  kind text not null check (kind in ('team', 'user')),
  team_id integer references teams(id) on delete cascade,
  github_id integer,
  github_login text,
  created_at text not null,
  check ((kind = 'team' and team_id is not null and github_id is null and github_login is null)
      or (kind = 'user' and team_id is null and github_id is not null and github_login is not null))
);
insert into sessions_new (id, kind, team_id, created_at) select id, 'team', team_id, created_at from sessions;
drop table sessions;
alter table sessions_new rename to sessions;
create index sessions_team on sessions (team_id);
create index sessions_github on sessions (github_id);
`;

/** Adds team codes, users and their roles in teams, and lets a session be a team's or a user's; every session so far is a team's. */
export const hostedTeams: Step = (db) => {
  db.exec(TEAM_CODES);
  db.exec(USERS_AND_ROLES);
  db.exec(SESSIONS_OF_TWO_KINDS);
};
