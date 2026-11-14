import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import type { Account, ApiError, AuthErrorCode } from "@ladybug/shared";
import type { AccountStore, UserRecord } from "@ladybug/backend";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 32;

/** "scrypt:<salt>:<key>", both base64url. */
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, key] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Checked against when the username doesn't exist, so a miss takes as long as a wrong password. */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));

/** Session tokens are random; only their SHA-256 is stored. */
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function bearerToken(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

export const publicAccount = ({ id, username, status, createdAt }: UserRecord): Account => ({
  id,
  username,
  status,
  createdAt,
});

/** The signed-in user, whatever their status, or null. */
export async function currentUser(accounts: AccountStore, req: Request) {
  const token = bearerToken(req);
  return token ? accounts.byToken(hashToken(token)) : null;
}

const AUTH_ERRORS: Record<AuthErrorCode, { status: number; error: string }> = {
  signed_out: { status: 401, error: "Sign in to use Ladybug" },
  pending: { status: 403, error: "Your account is waiting for an admin to approve it" },
  rejected: { status: 403, error: "An admin turned down this account" },
};

export function sendAuthError(res: Response, code: AuthErrorCode) {
  const { status, error } = AUTH_ERRORS[code];
  const body: ApiError = { error, code };
  res.status(status).json(body);
}

/** Why this user can't use the API yet, or null when they can. */
export function accessProblem(user: UserRecord | null): AuthErrorCode | null {
  if (!user) return "signed_out";
  if (user.status === "pending") return "pending";
  if (user.status === "rejected") return "rejected";
  return null;
}

/** Lets approved users through, with the user in `res.locals.user`. */
export function requireAccount(accounts: AccountStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = await currentUser(accounts, req);
    const problem = accessProblem(user);
    if (problem) return sendAuthError(res, problem);
    res.locals.user = user;
    next();
  };
}

/** The approved user `requireAccount` let through. */
export const userOf = (res: Response) => res.locals.user as UserRecord;
