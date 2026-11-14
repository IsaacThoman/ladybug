import type { NextFunction, Request, Response } from "express";
import { isStoreReady } from "./store.ts";
import { TypesenseError } from "./typesense.ts";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function requireString(value: unknown, name: string, maxLength = 4096) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${name}" must be a non-empty string`);
  }
  if (value.length > maxLength) throw new HttpError(400, `"${name}" is too long`);
  return value.trim();
}

export function optionalString(value: unknown, name: string, maxLength = 4096) {
  return value === undefined || value === "" ? undefined : requireString(value, name, maxLength);
}

export function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], name: string) {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new HttpError(400, `"${name}" must be one of: ${allowed.join(", ")}`);
}

/** Comma-separated list of enum values, e.g. "?type=decision,alert". */
export function optionalEnumList<T extends string>(value: unknown, allowed: readonly T[], name: string) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `"${name}" must be a string`);
  return value.split(",").map((item) => requireEnum(item.trim(), allowed, name));
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], name: string) {
  const result = optionalEnum(value, allowed, name);
  if (result === undefined) throw new HttpError(400, `"${name}" is required`);
  return result;
}

export function pageParams(query: Request["query"]) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(Number(query.perPage) || 25)));
  return { page, perPage };
}

/** 503 until Typesense is reachable and set up. */
export function requireStore(_req: Request, _res: Response, next: NextFunction) {
  if (!isStoreReady()) throw new HttpError(503, "Search store (Typesense) is not ready yet");
  next();
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof TypesenseError && error.status === 404) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  console.error(`[server] ${req.method} ${req.path} failed:`, error);
  const unavailable =
    error instanceof TypesenseError || (error instanceof Error && error.name === "TimeoutError") ||
    (error instanceof TypeError && error.message === "fetch failed");
  res
    .status(unavailable ? 503 : 500)
    .json({ error: unavailable ? "Search store (Typesense) is unavailable" : "Internal server error" });
}
