import { now, type Db } from "./db.js";

/** A GitHub user with a row in `users`. */
export type User = { id: number; githubId: number; login: string };

const USER_COLUMNS = "id, github_id as githubId, login";

/** The user with GitHub id `githubId`; null when the user has no row. */
export function findUser(db: Db, githubId: number): User | null {
  return (db.prepare(`select ${USER_COLUMNS} from users where github_id = ?`).get(githubId) as User | undefined) ?? null;
}

/** The user's row, created on first use; a changed login is stored. */
export function ensureUser(db: Db, who: { githubId: number; login: string }): User {
  return db
    .prepare(
      `insert into users (github_id, login, created_at) values (?, ?, ?)
       on conflict (github_id) do update set login = excluded.login
       returning ${USER_COLUMNS}`,
    )
    .get(who.githubId, who.login, now()) as User;
}
