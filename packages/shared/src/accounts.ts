// User accounts. People sign up with a username and password; an admin
// approves them in the admin UI before they can report visits, start scans or
// connect a pet. Clients send the token from sign-in as `Authorization: Bearer`.

/** pending: waiting for an admin. rejected: the admin said no (or revoked access). */
export type AccountStatus = "pending" | "approved" | "rejected";

export type Account = {
  id: string;
  username: string;
  status: AccountStatus;
  /** ISO 8601. */
  createdAt: string;
};

/** Lowercase letters, digits, dots, dashes and underscores. */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** Usernames are case-insensitive: "Alice" signs in as "alice". */
export const normalizeUsername = (value: string) => value.trim().toLowerCase();

/** POST /api/auth/signup and /api/auth/login. */
export type Credentials = { username: string; password: string };

export type AuthResponse = { token: string; account: Account };

/** GET /api/auth/me. */
export type MeResponse = { account: Account };

/**
 * Why a request with (or without) a token was refused, in `ApiError.code`:
 * 401 signed_out (no token, or it was revoked), 403 pending / rejected.
 */
export type AuthErrorCode = "signed_out" | "pending" | "rejected";

/** GET /api/admin/users. */
export type AdminAccount = Account & {
  /** ISO 8601: the last time any of the user's devices used the API. */
  lastSeenAt: string | null;
  /** Devices signed in right now. */
  sessions: number;
  /** The user's pet may place support calls (off until an admin turns it on). */
  callsEnabled: boolean;
};

export type AdminAccountsResponse = { accounts: AdminAccount[] };

/** PUT /api/admin/users/:id/calls. */
export type AdminCallsRequest = { enabled: boolean };
