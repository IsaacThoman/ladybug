// User accounts and their sign-in sessions. Passwords and tokens are hashed by
// the server before they get here; this file only stores and looks them up.
import type pg from "pg";
import type { Account, AccountStatus, AdminAccount } from "@ladybug/shared";
import type { Db } from "./db.ts";

export const ACCOUNTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash     text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
`;

export async function setupAccounts(client: pg.PoolClient) {
  await client.query(ACCOUNTS_TABLE_SQL);
}

/** A user as the server sees it, including the password hash. */
export type UserRecord = Account & { passwordHash: string };

/** Where accounts live. Postgres in the server; an in-memory map in tests. */
export type AccountStore = {
  /** null when the username is taken. */
  create(username: string, passwordHash: string): Promise<UserRecord | null>;
  byUsername(username: string): Promise<UserRecord | null>;
  /** The user a session token (hash) belongs to. Also marks the session as used. */
  byToken(tokenHash: string): Promise<UserRecord | null>;
  addSession(tokenHash: string, userId: string, client: string): Promise<void>;
  removeSession(tokenHash: string): Promise<void>;
  /** Signs the user out everywhere. */
  removeSessions(userId: string): Promise<void>;
  list(): Promise<AdminAccount[]>;
  countPending(): Promise<number>;
  setStatus(userId: string, status: AccountStatus): Promise<UserRecord | null>;
  remove(userId: string): Promise<UserRecord | null>;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  status: AccountStatus;
  created_at: Date;
};

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  username: row.username,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  passwordHash: row.password_hash,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAccountStore(db: Db): AccountStore {
  const one = async (sql: string, params: unknown[]) => {
    const { rows } = await db.query<UserRow>(sql, params);
    return rows[0] ? toUser(rows[0]) : null;
  };

  return {
    create: (username, passwordHash) =>
      one(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING RETURNING *",
        [username, passwordHash],
      ),

    byUsername: (username) => one("SELECT * FROM users WHERE username = $1", [username]),

    // Touch last_used_at at most once a minute, so every request isn't a write.
    byToken: (tokenHash) =>
      one(
        `WITH touched AS (
           UPDATE sessions SET last_used_at = now()
           WHERE token_hash = $1 AND last_used_at < now() - INTERVAL '1 minute'
         )
         SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = $1`,
        [tokenHash],
      ),

    async addSession(tokenHash, userId, client) {
      await db.query("INSERT INTO sessions (token_hash, user_id, client) VALUES ($1, $2, $3)", [
        tokenHash,
        userId,
        client,
      ]);
    },

    async removeSession(tokenHash) {
      await db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    },

    async removeSessions(userId) {
      await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    },

    async list() {
      const { rows } = await db.query<UserRow & { last_seen_at: Date | null; sessions: number }>(
        `SELECT users.*, max(sessions.last_used_at) AS last_seen_at, count(sessions.token_hash)::int AS sessions
         FROM users LEFT JOIN sessions ON sessions.user_id = users.id
         GROUP BY users.id
         ORDER BY users.status = 'pending' DESC, users.created_at DESC`,
      );
      return rows.map((row) => ({
        id: row.id,
        username: row.username,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        sessions: row.sessions,
      }));
    },

    async countPending() {
      const { rows } = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM users WHERE status = 'pending'",
      );
      return rows[0]?.count ?? 0;
    },

    setStatus: (userId, status) =>
      UUID_RE.test(userId) ? one("UPDATE users SET status = $2 WHERE id = $1 RETURNING *", [userId, status]) : Promise.resolve(null),

    remove: (userId) =>
      UUID_RE.test(userId) ? one("DELETE FROM users WHERE id = $1 RETURNING *", [userId]) : Promise.resolve(null),
  };
}
