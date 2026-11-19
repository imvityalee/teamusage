import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AccountLabel } from "@teamusage/shared";

/** Codex keeps its login in `auth.json`: under `CODEX_HOME` when that is an absolute path, else `~/.codex`. */
export function codexAuthPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CODEX_HOME;
  return dir && path.isAbsolute(dir) ? path.join(dir, "auth.json") : path.join(home, ".codex", "auth.json");
}

const LABEL_BY_PLAN: Readonly<Record<string, AccountLabel>> = {
  free: { kind: "personal", plan: "free" },
  plus: { kind: "personal", plan: "plus" },
  pro: { kind: "personal", plan: "pro" },
  business: { kind: "team", plan: "business" },
  team: { kind: "team", plan: "business" },
  enterprise: { kind: "enterprise", plan: "enterprise" },
  edu: { kind: "enterprise", plan: "edu" },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only the plan claim of the id_token payload; nothing else in the token is kept. */
function planClaim(idToken: string): string | undefined {
  const segments = idToken.split(".");
  if (segments.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1] as string, "base64url").toString("utf8"));
    if (!isObject(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isObject(auth)) return undefined;
    const plan = auth.chatgpt_plan_type;
    return typeof plan === "string" ? plan : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The current Codex login as an account label. Only whether `OPENAI_API_KEY` is a non-empty string and the
 * id_token's `chatgpt_plan_type` claim are read. Any problem gives null.
 */
export function readCodexAccount(
  deps: { env?: NodeJS.ProcessEnv; home?: string | (() => string); readFile?: (p: string) => string } = {},
): AccountLabel | null {
  const { env = process.env, home = homedir, readFile = (p: string) => readFileSync(p, "utf8") } = deps;
  try {
    const parsed: unknown = JSON.parse(readFile(codexAuthPath(env, typeof home === "function" ? home() : home)));
    if (!isObject(parsed)) return null;
    const tokens = parsed.tokens;
    const idToken = isObject(tokens) ? tokens.id_token : undefined;
    if (typeof idToken === "string" && idToken !== "") {
      const plan = planClaim(idToken);
      return plan !== undefined && Object.hasOwn(LABEL_BY_PLAN, plan) ? { ...(LABEL_BY_PLAN[plan] as AccountLabel) } : null;
    }
    const key = parsed.OPENAI_API_KEY;
    return typeof key === "string" && key !== "" ? { kind: "api" } : null;
  } catch {
    return null;
  }
}
