import { isIPv4, isIPv6 } from "node:net";

/**
 * In-memory limiter that counts events per key in fixed windows.
 * Memory is bounded: keys are capped in length and count, and live entries are never evicted. When the table
 * is full of live entries, a key it cannot track is allowed (fail open): a full table must not lock everyone
 * out. Tracked keys keep their own limits.
 */
export interface Limiter {
  /** Seconds to wait when the key is blocked, otherwise null. */
  retryAfter(key: string): number | null;
  /** Counts one event for the key, or an event of `weight`. */
  count(key: string, weight?: number): void;
  size(): number;
}

/** A minute in milliseconds: the window of every per-minute limit. */
export const MINUTE_MS = 60_000;

const MAX_KEY_CHARS = 64;
const PURGE_INTERVAL_MS = 1000;

export function createLimiter(o: {
  max?: number;
  windowMs?: number;
  maxKeys?: number;
  now: () => number;
}): Limiter {
  const max = o.max ?? 10;
  const windowMs = o.windowMs ?? 10 * 60 * 1000;
  const maxKeys = o.maxKeys ?? 10_000;
  const entries = new Map<string, { count: number; resetAt: number }>();
  let lastPurge = Number.NEGATIVE_INFINITY;

  const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

  const purge = (at: number): void => {
    if (at - lastPurge < PURGE_INTERVAL_MS) return;
    lastPurge = at;
    for (const [k, e] of entries) if (e.resetAt <= at) entries.delete(k);
  };

  return {
    retryAfter(rawKey) {
      const key = rawKey.slice(0, MAX_KEY_CHARS);
      const at = o.now();
      const e = entries.get(key);
      return e && e.resetAt > at && e.count >= max ? seconds(e.resetAt - at) : null;
    },
    count(rawKey, weight = 1) {
      const key = rawKey.slice(0, MAX_KEY_CHARS);
      const at = o.now();
      const e = entries.get(key);
      if (e && e.resetAt > at) {
        e.count += weight;
        return;
      }
      entries.delete(key);
      if (entries.size >= maxKeys) purge(at);
      // Still full of live entries: this key is not tracked, so it is not limited (fail open).
      if (entries.size < maxKeys) entries.set(key, { count: weight, resetAt: at + windowMs });
    },
    size: () => entries.size,
  };
}

const MAX_RAW_CHARS = 100;
const isPort = (p: string | undefined): boolean => p !== undefined && /^\d{1,5}$/.test(p) && Number(p) <= 65535;

/** The eight hextets of a valid IPv6 address (an embedded dotted IPv4 tail becomes two hextets). */
function hextets(v: string): number[] {
  let s = v.toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = (dotted[2] as string).split(".").map(Number) as [number, number, number, number];
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const part = (x: string | undefined) => (x ? x.split(":").map((h) => parseInt(h, 16)) : []);
  const left = part(head);
  const right = part(tail);
  return tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * One key per client for limiting: IPv4 as is; IPv4-mapped IPv6 as its IPv4 address; any other IPv6 address
 * reduced to its /64 (one host usually holds a whole /64). Brackets, a zone id and a port are removed first.
 * Anything that is not an IP address is "unknown".
 */
function normalise(s: string | undefined): string {
  let v = s?.trim() ?? "";
  if (v.length === 0 || v.length > MAX_RAW_CHARS) return "unknown";
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(v);
  const v4WithPort = /^(\d+\.\d+\.\d+\.\d+):(.*)$/.exec(v);
  if (bracketed) {
    if (bracketed[2] !== undefined && !isPort(bracketed[2])) return "unknown";
    v = bracketed[1] as string;
    if (isIPv4(v)) return "unknown"; // brackets are for IPv6 only
  } else if (v4WithPort) {
    if (!isPort(v4WithPort[2])) return "unknown";
    v = v4WithPort[1] as string;
  }
  const zone = v.indexOf("%");
  if (zone !== -1) {
    if (zone === v.length - 1 || !isIPv6(v.slice(0, zone))) return "unknown";
    v = v.slice(0, zone);
  }
  if (isIPv4(v)) return v;
  if (!isIPv6(v)) return "unknown";
  const h = hextets(v);
  if (h.length !== 8 || h.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return "unknown";
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    const [hi, lo] = [h[6] as number, h[7] as number];
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * The client address for limiting. `trustedProxies` is how many reverse proxies sit in front of the server:
 * with 0 only the socket address is used; with N the Nth entry from the right of X-Forwarded-For is used (each
 * trusted proxy appends the address it saw, so entries to the left of that are client-controlled).
 */
export function clientKeyFrom(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: number,
): string {
  if (trustedProxies >= 1 && forwardedFor) {
    const parts = forwardedFor.split(",");
    const picked = parts[parts.length - trustedProxies];
    if (parts.length >= trustedProxies && picked !== undefined) return normalise(picked);
  }
  return normalise(remoteAddress);
}
