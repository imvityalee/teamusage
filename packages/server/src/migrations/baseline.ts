import type { Step } from "../migrate.js";

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
export const baseline: Step = (db) => {
  db.exec(BASELINE_SCHEMA);
  const have = new Set((db.prepare("pragma table_info(usage)").all() as { name: string }[]).map((c) => c.name));
  for (const col of ["account_kind", "account_org", "account_plan"]) {
    if (!have.has(col)) db.exec(`alter table usage add column ${col} text`);
  }
};
