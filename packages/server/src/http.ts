import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppOptions } from "./app-context.js";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const SESSION_COOKIE = "tu_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

const BEARER = /^Bearer (\S+)$/;

export const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503, error: string) => c.json({ error }, status);

/** Parses the JSON body; undefined when it is not valid JSON. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON body when it is an object; otherwise the 400 that refuses it, "invalid JSON body" or "body must be an object". */
export async function readObject(c: Context): Promise<Record<string, unknown> | Response> {
  const body = await readJson(c);
  if (body === undefined) return fail(c, 400, "invalid JSON body");
  if (!isObject(body)) return fail(c, 400, "body must be an object");
  return body;
}

/** The token of an `Authorization: Bearer` header; undefined when there is none. */
export const bearerToken = (c: Context): string | undefined => BEARER.exec(c.req.header("Authorization") ?? "")?.[1];

const forwardedProto = (c: Context): string =>
  (c.req.header("X-Forwarded-Proto")?.split(",")[0] ?? "").trim().toLowerCase();

/** True when the browser reached the server over https, directly or through a proxy that says so. */
const overHttps = (c: Context): boolean => new URL(c.req.url).protocol === "https:" || forwardedProto(c) === "https";

/** Sets a cookie with the attributes of every cookie the server sets: HttpOnly, SameSite=Lax, Secure over https. */
export function setPrivateCookie(c: Context, name: string, value: string, a: { path: string; maxAge: number }): void {
  setCookie(c, name, value, { httpOnly: true, sameSite: "Lax", secure: overHttps(c), ...a });
}

/** Expires a cookie set with setPrivateCookie on `path`. */
export function clearPrivateCookie(c: Context, name: string, path: string): void {
  deleteCookie(c, name, { httpOnly: true, sameSite: "Lax", secure: overHttps(c), path });
}

/** Sets the dashboard's session cookie to the session `id`. */
export const setSessionCookie = (c: Context, id: string): void =>
  setPrivateCookie(c, SESSION_COOKIE, id, { path: "/", maxAge: SESSION_MAX_AGE_S });

export const clearSessionCookie = (c: Context): void => clearPrivateCookie(c, SESSION_COOKIE, "/");

/** 403 "cross-site request refused" unless the Origin header equals `publicUrl`; otherwise null. */
export function crossSite(c: Context, publicUrl: string): Response | null {
  return c.req.header("Origin") === publicUrl ? null : fail(c, 403, "cross-site request refused");
}

/**
 * The 403 for a sign-in that does not come from the server's own pages, when the server knows its address (a hosted
 * server's `hosted.publicUrl`, or a self-hosted operator's `signInOrigin`); otherwise null. Both are positional so
 * that a caller cannot leave one out.
 */
export function signInCrossSite(c: Context, hosted: AppOptions["hosted"], signInOrigin: AppOptions["signInOrigin"]): Response | null {
  const origin = hosted?.publicUrl ?? signInOrigin;
  return origin === undefined ? null : crossSite(c, origin);
}

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
