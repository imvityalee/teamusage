import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sha256 } from "./db.js";

const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1.";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A new team code: 24 lowercase hex characters, the format clients already accept. */
export function newTeamCode(): string {
  return randomBytes(12).toString("hex");
}

export function codeHash(code: string): string {
  return sha256(code);
}

/** Throws without naming the key, so that a wrong key never reaches a log line. */
function requireKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`the team code key must be ${KEY_BYTES} bytes`);
}

/** AES-256-GCM under `key` with a fresh 12-byte iv: "v1." + base64url(iv + ciphertext + tag). */
export function sealCode(code: string, key: Buffer): string {
  requireKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  const sealed = Buffer.concat([iv, cipher.update(code, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return VERSION + sealed.toString("base64url");
}

/** The bytes of a sealed text in this version's format, or null; only the canonical base64url spelling is accepted. */
function sealedBytes(sealed: string): Buffer | null {
  if (!sealed.startsWith(VERSION)) return null;
  const text = sealed.slice(VERSION.length);
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text || bytes.length <= IV_BYTES + TAG_BYTES) return null;
  return bytes;
}

/** The sealed code, or null when the key is another one or the text was altered. */
export function openCode(sealed: string, key: Buffer): string | null {
  requireKey(key);
  const bytes = typeof sealed === "string" ? sealedBytes(sealed) : null;
  if (!bytes) return null;
  try {
    const decipher = createDecipheriv(CIPHER, key, bytes.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const ciphertext = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
