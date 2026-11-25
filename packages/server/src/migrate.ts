import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";

/** One numbered upgrade of the database; step N moves it from version N - 1 to N. */
export type Step = (db: Db) => void;

/** The database was written by a release newer than this one. */
export class NewerSchemaError extends Error {
  constructor() {
    super("the database was written by a newer teamusage");
    this.name = "NewerSchemaError";
  }
}

const BASELINE = 1;

const BASELINE_SCHEMA = `
create table if not exists members (
  id integer primary key autoincrement,
  email text not null unique,
  name text not null,
  created_at text not null
);
create table if not exists machines (
  id text primary key,
  member_id integer not null references members(id) on delete cascade,
  label text not null,
  token_hash text not null unique,
  created_at text not null,
  last_sync_at text
);
create table if not exists usage (
  member_id integer not null references members(id) on delete cascade,
  machine_id text not null references machines(id) on delete cascade,
  date text not null,
  agent text not null,
  model text not null,
  input integer not null,
  output integer not null,
  cache_create integer not null,
  cache_read integer not null,
  total integer not null,
  cost_usd real not null,
  unpriced integer not null,
  primary key (machine_id, date, agent, model)
);
create index if not exists usage_member_date on usage (member_id, date);
create table if not exists settings (key text primary key, value text not null);
create table if not exists sessions (id text primary key, created_at text not null);
`;

/** The schema of 0.1 to 0.3, which had no version number: creates what is missing and adds the account columns. */
const baseline: Step = (db) => {
  db.exec(BASELINE_SCHEMA);
  const have = new Set((db.prepare("pragma table_info(usage)").all() as { name: string }[]).map((c) => c.name));
  for (const col of ["account_kind", "account_org", "account_plan"]) {
    if (!have.has(col)) db.exec(`alter table usage add column ${col} text`);
  }
};

// `teams` is new and takes its final name at once; the other tables are built under `_new` names and refer to the final
// names, which they take once the old tables are dropped.
const TEAM_KEYED_TABLES = `
create table teams (
  id integer primary key autoincrement,
  public_id text not null unique,
  name text not null,
  dashboard_access text not null default 'code' check (dashboard_access in ('code', 'admins')),
  created_at text not null
);
create table members_new (
  id integer primary key autoincrement,
  team_id integer not null references teams(id) on delete cascade,
  email text not null,
  name text not null,
  created_at text not null,
  unique (team_id, email),
  unique (id, team_id)
);
create table machines_new (
  team_id integer not null references teams(id) on delete cascade,
  id text not null,
  member_id integer not null,
  label text not null,
  token_hash text not null unique,
  created_at text not null,
  last_sync_at text,
  primary key (team_id, id),
  foreign key (member_id, team_id) references members(id, team_id) on delete cascade
);
create table usage_new (
  team_id integer not null,
  member_id integer not null,
  machine_id text not null,
  date text not null,
  agent text not null,
  model text not null,
  input integer not null,
  output integer not null,
  cache_create integer not null,
  cache_read integer not null,
  total integer not null,
  cost_usd real not null,
  unpriced integer not null,
  account_kind text,
  account_org text,
  account_plan text,
  primary key (team_id, machine_id, date, agent, model),
  foreign key (team_id, machine_id) references machines(team_id, id) on delete cascade,
  foreign key (member_id, team_id) references members(id, team_id) on delete cascade
);
create table sessions_new (
  id text primary key,
  team_id integer not null references teams(id) on delete cascade,
  created_at text not null
);
`;

// The id counter moves with the table, so the id of a removed member is never handed out again.
const KEEP_MEMBER_ID_COUNTER =
  "insert into sqlite_sequence (name, seq) select 'members_new', seq from sqlite_sequence where name = 'members'";

// A machine is copied only with its member, a usage row only with its machine and its member: nothing is left dangling.
const COPY_INTO_TEAM = [
  "insert into members_new (id, team_id, email, name, created_at) select id, @team, email, name, created_at from members",
  `insert into machines_new (team_id, id, member_id, label, token_hash, created_at, last_sync_at)
     select @team, id, member_id, label, token_hash, created_at, last_sync_at from machines
     where member_id in (select id from members_new)`,
  `insert into usage_new (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total,
       cost_usd, unpriced, account_kind, account_org, account_plan)
     select @team, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total,
       cost_usd, unpriced, account_kind, account_org, account_plan from usage
     where machine_id in (select id from machines_new) and member_id in (select id from members_new)`,
  "insert into sessions_new (id, team_id, created_at) select id, @team, created_at from sessions",
];

const REPLACE_OLD_TABLES = `
drop table usage;
drop table machines;
drop table members;
drop table sessions;
alter table members_new rename to members;
alter table machines_new rename to machines;
alter table usage_new rename to usage;
alter table sessions_new rename to sessions;
create index machines_team_member on machines (team_id, member_id);
create index usage_team_date on usage (team_id, date);
create index usage_team_member_date on usage (team_id, member_id, date);
create index sessions_team on sessions (team_id);
`;

const hasRows = (db: Db, table: string): boolean => db.prepare(`select 1 from ${table} limit 1`).get() !== undefined;

/** Keys members, machines, usage and sessions by team; a database that has members or sessions moves into team 1. */
const teamKeys: Step = (db) => {
  db.exec(TEAM_KEYED_TABLES);
  db.exec(KEEP_MEMBER_ID_COUNTER);
  if (hasRows(db, "members") || hasRows(db, "sessions")) {
    // A step stays as it was written, so it inserts the team with its own SQL rather than through createTeam.
    const team = db
      .prepare("insert into teams (public_id, name, created_at) values (?, 'Team', ?)")
      .run(randomBytes(8).toString("hex"), new Date().toISOString()).lastInsertRowid;
    for (const sql of COPY_INTO_TEAM) db.prepare(sql).run({ team });
  }
  db.exec(REPLACE_OLD_TABLES);
};

// Each index holds every column its stats pass reads, in that pass's group order, so SQLite aggregates as it reads.
const ORDERED_USAGE_INDEXES = `
drop index usage_team_date;
drop index usage_team_member_date;
create index usage_by_day on usage (team_id, date, agent, model, account_kind, account_org, account_plan,
  input, output, cache_create, cache_read, total, cost_usd, unpriced, member_id);
create index usage_by_member on usage (team_id, member_id, agent, account_kind, account_org, account_plan,
  date, model, total, cost_usd);
`;

/** Replaces the usage indexes with two that deliver the rows of the stats passes already grouped. */
const orderedUsageIndexes: Step = (db) => {
  db.exec(ORDERED_USAGE_INDEXES);
};

export const STEPS: readonly Step[] = [baseline, teamKeys, orderedUsageIndexes];

export const SCHEMA_VERSION = STEPS.length;

function readVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function assertNoDanglingReferences(db: Db): void {
  if ((db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("the upgrade left a row that refers to a missing row");
}

/** Runs the step unless the database is already at its number; the version is read in the transaction that acts on it. */
function applyStep(db: Db, step: Step, number: number): void {
  db.transaction(() => {
    if (readVersion(db) >= number) return;
    step(db);
    // A database from before versioned upgrades may hold rows whose owner is gone; the baseline takes it as it is.
    if (number !== BASELINE) assertNoDanglingReferences(db);
    db.pragma(`user_version = ${number}`);
  }).immediate();
}

export function runSteps(db: Db, steps: readonly Step[]): void {
  if (readVersion(db) > steps.length) throw new NewerSchemaError();
  // SQLite ignores this pragma inside a transaction, so it is switched around the steps' transactions.
  db.pragma("foreign_keys = OFF");
  try {
    steps.forEach((step, index) => applyStep(db, step, index + 1));
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function migrate(db: Db): void {
  runSteps(db, STEPS);
}
