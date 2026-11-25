import Database from "better-sqlite3";
import type { Db } from "../db.js";
import { runSteps, STEPS } from "../migrate.js";

/** The schema text from before versioned upgrades (the 0.1/0.2 shape; 0.3.x databases additionally have the three account columns on usage). */
export const LEGACY_SCHEMA = `
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

export const MID = "a".repeat(32);
export const H = "h".repeat(64); // a token hash
export const S = "s".repeat(64); // a session id hash

/** An empty database of the 0.1 shape, with no version number. */
export const legacy = (): Db => { const db = new Database(":memory:"); db.exec(LEGACY_SCHEMA); return db; };

/** An empty 0.3 database: it has the account columns and has never recorded a version. */
export function legacy03(): Db {
  const db = legacy();
  runSteps(db, [STEPS[0]!]);
  db.pragma("user_version = 0");
  return db;
}

/** A 0.3 database: one member, one machine, two usage rows, one session. */
export function legacyWithData(): Db {
  const db = legacy03();
  db.exec(`
    insert into members (id, email, name, created_at) values (7, 'ann@x.com', 'Ann', '2026-11-01T00:00:00.000Z');
    insert into machines (id, member_id, label, token_hash, created_at, last_sync_at)
      values ('${MID}', 7, 'mbp', '${H}', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    insert into usage (member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
      values (7, '${MID}', '2026-11-01', 'claude', 'm', 1, 1, 1, 1, 4, 0.5, 0),
             (7, '${MID}', '2026-11-02', 'claude', 'm', 2, 2, 2, 2, 8, 1.0, 0);
    insert into sessions (id, created_at) values ('${S}', '${new Date().toISOString()}');
  `);
  return db;
}
