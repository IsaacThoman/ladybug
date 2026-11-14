import express from "express";
import type { Request, Response } from "express";
import type { Redis } from "ioredis";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
  normalizeUsername,
} from "@ladybug/shared";
import type { AuthResponse, MeResponse } from "@ladybug/shared";
import type { AccountStore, UserRecord } from "@ladybug/backend";
import {
  DUMMY_HASH,
  bearerToken,
  currentUser,
  hashPassword,
  hashToken,
  newToken,
  publicAccount,
  sendAuthError,
  verifyPassword,
} from "../accounts.ts";
import { logEvent } from "../activity.ts";
import { HttpError, optionalEnum } from "../http.ts";

/** Sign-ups and sign-ins allowed per client IP per minute. */
export const AUTH_ATTEMPTS_PER_MINUTE = 10;

const CLIENTS = ["web", "extension", "desktop"] as const;

/** Returns false when `key` is over its limit for this minute. */
export type Limiter = (key: string) => Promise<boolean>;

/** A fixed one-minute window in Valkey, like the scan rate limit. */
export function redisLimiter(redis: Redis, perMinute: number): Limiter {
  return async (key) => {
    const bucket = `ratelimit:${key}:${Math.floor(Date.now() / 60_000)}`;
    const result = await redis.multi().incr(bucket).expire(bucket, 120).exec();
    return Number(result?.[0]?.[1] ?? 0) <= perMinute;
  };
}

export type AuthRouterDeps = {
  accounts: AccountStore;
  limit: Limiter;
  /** Trusted header with the real client IP (CLIENT_IP_HEADER). */
  clientIpHeader?: string | null;
};

function readCredentials(body: unknown) {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.username !== "string" || typeof input.password !== "string") {
    throw new HttpError(400, "Enter a username and a password");
  }
  return { username: normalizeUsername(input.username), password: input.password };
}

export function authRouter({ accounts, limit, clientIpHeader }: AuthRouterDeps) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const throttle = async (req: Request) => {
    const ip = (clientIpHeader && req.header(clientIpHeader)?.trim()) || req.ip;
    if (!(await limit(`auth:${ip}`))) throw new HttpError(429, "Too many attempts. Try again in a minute");
  };

  /** Starts a session on a new device and answers with its token. */
  const signIn = async (req: Request, res: Response, user: UserRecord, status: number) => {
    const token = newToken();
    const client = optionalEnum(req.body?.client, CLIENTS, "client") ?? "web";
    await accounts.addSession(hashToken(token), user.id, client);
    const body: AuthResponse = { token, account: publicAccount(user) };
    res.status(status).json(body);
  };

  // New accounts wait for an admin, but can sign in meanwhile to see that.
  router.post("/signup", async (req, res) => {
    await throttle(req);
    const { username, password } = readCredentials(req.body);
    if (!USERNAME_PATTERN.test(username)) {
      throw new HttpError(400, "Usernames are 3 to 32 letters, digits, dots, dashes or underscores");
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new HttpError(400, `Passwords need at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    if (password.length > PASSWORD_MAX_LENGTH) throw new HttpError(400, "That password is too long");
    const user = await accounts.create(username, await hashPassword(password));
    if (!user) throw new HttpError(409, "That username is taken");
    logEvent({
      type: "account",
      message: `${username} signed up and is waiting for approval`,
      details: { userId: user.id, user: username },
    });
    await signIn(req, res, user, 201);
  });

  router.post("/login", async (req, res) => {
    await throttle(req);
    const { username, password } = readCredentials(req.body);
    const user = await accounts.byUsername(username);
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, "Wrong username or password");
    if (user.status === "rejected") return sendAuthError(res, "rejected");
    await signIn(req, res, user, 200);
  });

  router.post("/logout", async (req, res) => {
    const token = bearerToken(req);
    if (token) await accounts.removeSession(hashToken(token));
    res.status(204).end();
  });

  // Any status: clients poll this to see when they're approved.
  router.get("/me", async (req, res) => {
    const user = await currentUser(accounts, req);
    if (!user) return sendAuthError(res, "signed_out");
    const body: MeResponse = { account: publicAccount(user) };
    res.json(body);
  });

  return router;
}
