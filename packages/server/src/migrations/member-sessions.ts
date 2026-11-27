import type { Step } from "../migrate.js";

// The table is built under a `_new` name and takes the final name once the old one, and its indexes, are dropped. A
// member's session refers to its machine, so the database deletes it with the machine, and with the machine's member.
// `sessions_member` leads with team_id, so it also serves what `sessions_team` served.
const SESSIONS_OF_THREE_KINDS = `
create table sessions_new (
  id text primary key,
  kind text not null check (kind in ('team', 'member', 'user')),
  team_id integer references teams(id) on delete cascade,
  machine_id text,
  member_id integer,
  github_id integer,
  github_login text,
  created_at text not null,
  foreign key (team_id, machine_id) references machines(team_id, id) on delete cascade,
  check ((kind = 'team' and team_id is not null and machine_id is null and member_id is null
          and github_id is null and github_login is null)
      or (kind = 'member' and team_id is not null and machine_id is not null and member_id is not null
          and github_id is null and github_login is null)
      or (kind = 'user' and team_id is null and machine_id is null and member_id is null
          and github_id is not null and github_login is not null))
);
insert into sessions_new (id, kind, team_id, github_id, github_login, created_at)
  select id, kind, team_id, github_id, github_login, created_at from sessions;
drop table sessions;
alter table sessions_new rename to sessions;
create index sessions_member on sessions (team_id, member_id);
create index sessions_machine on sessions (team_id, machine_id);
create index sessions_github on sessions (github_id);
`;

// One pending link per machine, stored as the hash of its token; it goes with its machine.
const DASHBOARD_LINKS = `
create table dashboard_links (
  token_hash text primary key,
  team_id integer not null,
  machine_id text not null,
  member_id integer not null,
  expires_at text not null,
  unique (team_id, machine_id),
  foreign key (team_id, machine_id) references machines(team_id, id) on delete cascade
);
`;

/** Lets a session be a member's, opened from one of their machines, and adds the one-time links that open one. */
export const memberSessions: Step = (db) => {
  db.exec(SESSIONS_OF_THREE_KINDS);
  db.exec(DASHBOARD_LINKS);
};
