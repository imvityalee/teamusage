import type { Context } from "hono";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const SESSION_COOKIE = "tu_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

const BEARER = /^Bearer (\S+)$/;

export const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500, error: string) => c.json({ error }, status);

/** Parses the JSON body; undefined when it is not valid JSON. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The token of an `Authorization: Bearer` header; undefined when there is none. */
export const bearerToken = (c: Context): string | undefined => BEARER.exec(c.req.header("Authorization") ?? "")?.[1];

export const forwardedProto = (c: Context): string =>
  (c.req.header("X-Forwarded-Proto")?.split(",")[0] ?? "").trim().toLowerCase();

/**
 * The error's class name and its `code`, for an operator's trace of a 500. Never the message, which can hold
 * paths or submitted values, and nothing from the request.
 */
export function errorTrace(err: unknown): string {
  const ctor = typeof err === "object" && err !== null ? (err as { constructor?: { name?: unknown } }).constructor?.name : undefined;
  const name = typeof ctor === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(ctor) ? ctor : "unknown";
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? `${name} ${code}` : name;
}
