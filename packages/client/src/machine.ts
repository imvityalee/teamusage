import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * A per-member, per-machine id: sha256(osId + ":" + email), first 32 hex chars.
 * The OS identifier itself never leaves the machine.
 */
export function machineId(email: string, osId: string | null = readOsId()): string {
  if (!osId) throw new Error("no OS machine identifier available");
  return createHash("sha256")
    .update(`${osId}:${email.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

/** macOS: IOPlatformUUID via ioreg (no shell); Linux: /etc/machine-id; anything else or any failure: null. */
export function readOsId(): string | null {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
    }
    if (process.platform === "linux") {
      return readFileSync("/etc/machine-id", "utf8").trim() || null;
    }
  } catch {
    // fall through
  }
  return null;
}

/** The hostname, without control characters, at most 100 chars; "unknown" when empty. */
export function machineLabel(): string {
  return os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100).trim() || "unknown";
}
