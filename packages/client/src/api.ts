import type { UsageRecord } from "@teamusage/shared";
import { UserError } from "./errors.js";
import { clean } from "./text.js";

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * `status` is the HTTP status, or 0 when the server could not be reached.
 * Messages hold only the status and the server's `error` string (cleaned and truncated); never tokens or invite codes.
 */
export class ApiError extends UserError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RegisterBody {
  inviteCode: string;
  name: string;
  email: string;
  machineId: string;
  machineLabel: string;
}

/** Reads the body as text, refusing more than 5 MB (checked up front from Content-Length, then while streaming). */
async function readCapped(res: Response): Promise<string> {
  const tooLarge = () => new ApiError(res.status, "the server's response was too large");
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serverError(res: Response): Promise<string> {
  try {
    const body = JSON.parse(await readCapped(res)) as unknown;
    const err = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
    if (typeof err !== "string") return "";
    return clean(err);
  } catch {
    return "";
  }
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new ApiError(0, timedOut ? "the server did not respond in time" : "could not reach the server");
  }
  if (!res.ok) {
    const err = await serverError(res);
    throw new ApiError(res.status, `server responded ${res.status}${err ? `: ${err}` : ""}`);
  }
  const text = await readCapped(res); // too large -> its own fixed error
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(res.status, "the server sent an unexpected response");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unexpected = () => new ApiError(200, "the server sent an unexpected response");
const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

export async function register(serverUrl: string, body: RegisterBody): Promise<{ token: string }> {
  const res = await request(`${serverUrl}/api/register`, json(body));
  if (!isObj(res) || typeof res.token !== "string" || res.token === "") throw unexpected();
  return { token: res.token };
}

export async function upload(
  serverUrl: string,
  token: string,
  records: UsageRecord[],
): Promise<{ stored: number; kept: number }> {
  const res = await request(`${serverUrl}/api/usage`, json({ records }, token));
  if (!isObj(res) || typeof res.stored !== "number" || typeof res.kept !== "number") throw unexpected();
  return { stored: res.stored, kept: res.kept };
}

/** The parsed stats answer, unchecked beyond being JSON; `readReport` checks and cleans it. */
export async function fetchStats(
  serverUrl: string,
  token: string,
  q: { from: string; to: string; member?: "me" },
): Promise<unknown> {
  const params = new URLSearchParams({ from: q.from, to: q.to });
  if (q.member) params.set("member", q.member);
  return request(`${serverUrl}/api/stats?${params}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
}

/** True when GET /api/health answers 200. */
export async function health(serverUrl: string): Promise<boolean> {
  try {
    await request(`${serverUrl}/api/health`, { method: "GET" });
    return true;
  } catch {
    return false;
  }
}
