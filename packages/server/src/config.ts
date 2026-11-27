export interface HostedConfig {
  /** The server's own origin, without a trailing slash, for example "https://teamusage.dev". */
  publicUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  /** 32 bytes; seals team codes. */
  codeKey: Buffer;
  maxTeams: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  inviteCodeFromEnv: string | undefined;
  demo: boolean;
  trustedProxies: number;
  mode: "self-hosted" | "hosted";
  /** Set exactly when `mode` is "hosted". */
  hosted: HostedConfig | undefined;
  /** A self-hosted server's own origin, from TEAMUSAGE_PUBLIC_URL when its operator set it; always undefined in hosted mode, whose origin is `hosted.publicUrl`. */
  publicUrl: string | undefined;
}

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const HAS_SPACE_OR_CONTROL = /[\s\x00-\x1f\x7f]/;

const PUBLIC_URL_MESSAGE = "TEAMUSAGE_PUBLIC_URL must be an https origin such as https://example.com (http only for localhost)";
const SELF_HOSTED_URL_MESSAGE = "TEAMUSAGE_PUBLIC_URL must be an origin such as https://usage.example.com, with no path";
const GITHUB_MESSAGE = "hosted mode needs TEAMUSAGE_GITHUB_CLIENT_ID and TEAMUSAGE_GITHUB_CLIENT_SECRET";
const CODE_KEY_MESSAGE = "TEAMUSAGE_CODE_KEY must be 32 random bytes in base64 (openssl rand -base64 32)";

function integer(v: string | undefined, def: number, min: number, max: number, message: string): number {
  if (v === undefined || v === "") return def;
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(message);
  return n;
}

/** The origin of `value` when it is a bare origin whose scheme and host `allowed` accepts; otherwise `fail`'s error. */
function parseOrigin(value: string | undefined, message: string, allowed: (url: URL) => boolean): string {
  const fail = (): never => {
    throw new Error(message);
  };
  if (!value || HAS_SPACE_OR_CONTROL.test(value) || /[?#]/.test(value)) return fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  if (!allowed(url) || url.pathname !== "/" || url.username !== "" || url.password !== "") return fail();
  return url.origin;
}

/** A hosted server's origin: https, or http only for the machine itself. */
function parsePublicUrl(value: string | undefined): string {
  const schemeAllowed = (url: URL) => url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
  return parseOrigin(value, PUBLIC_URL_MESSAGE, schemeAllowed);
}

/** A self-hosted server's origin when its operator set one: http or https on any host; undefined when unset or empty. */
function parseSelfHostedUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return parseOrigin(value, SELF_HOSTED_URL_MESSAGE, (url) => url.protocol === "https:" || url.protocol === "http:");
}

function parseGithubSetting(value: string | undefined): string {
  if (!value || value.length > 200 || HAS_SPACE_OR_CONTROL.test(value)) throw new Error(GITHUB_MESSAGE);
  return value;
}

/** Strict base64: text that does not re-encode to itself had characters Buffer would skip or bits it would drop. */
function parseCodeKey(value: string | undefined): Buffer {
  const key = Buffer.from(value ?? "", "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error(CODE_KEY_MESSAGE);
  return key;
}

function parseHosted(env: Env): HostedConfig {
  const publicUrl = parsePublicUrl(env.TEAMUSAGE_PUBLIC_URL);
  return {
    publicUrl,
    githubClientId: parseGithubSetting(env.TEAMUSAGE_GITHUB_CLIENT_ID),
    githubClientSecret: parseGithubSetting(env.TEAMUSAGE_GITHUB_CLIENT_SECRET),
    codeKey: parseCodeKey(env.TEAMUSAGE_CODE_KEY),
    maxTeams: integer(env.TEAMUSAGE_MAX_TEAMS, 200, 1, 100000, "TEAMUSAGE_MAX_TEAMS must be an integer from 1 to 100000"),
  };
}

function parseMode(value: string | undefined): ServerConfig["mode"] {
  if (value === undefined || value === "" || value === "self-hosted") return "self-hosted";
  if (value === "hosted") return "hosted";
  throw new Error("TEAMUSAGE_MODE must be self-hosted or hosted");
}

/** Messages are fixed: they never include the offending value. */
export function parseServerConfig(env: Env, argv: string[]): ServerConfig {
  const mode = parseMode(env.TEAMUSAGE_MODE);
  const invite = env.TEAMUSAGE_INVITE_CODE || undefined;
  const demo = env.TEAMUSAGE_DEMO === "1" || argv.includes("--demo");
  if (mode === "hosted" && invite !== undefined) {
    throw new Error("TEAMUSAGE_INVITE_CODE is not used in hosted mode; each team has its own code");
  }
  if (invite !== undefined && (invite.length < 16 || invite.length > 128 || HAS_SPACE_OR_CONTROL.test(invite))) {
    throw new Error("TEAMUSAGE_INVITE_CODE must be 16 to 128 characters with no spaces");
  }
  if (mode === "hosted" && demo) throw new Error("demo mode is not available in hosted mode");
  return {
    port: integer(env.PORT, 8787, 1, 65535, "PORT must be an integer from 1 to 65535"),
    host: env.TEAMUSAGE_HOST || "0.0.0.0",
    dataDir: env.TEAMUSAGE_DATA_DIR || "/data",
    inviteCodeFromEnv: invite,
    demo,
    trustedProxies: integer(env.TEAMUSAGE_TRUSTED_PROXIES, 0, 0, 10, "TEAMUSAGE_TRUSTED_PROXIES must be an integer from 0 to 10"),
    mode,
    hosted: mode === "hosted" ? parseHosted(env) : undefined,
    publicUrl: mode === "hosted" ? undefined : parseSelfHostedUrl(env.TEAMUSAGE_PUBLIC_URL),
  };
}
