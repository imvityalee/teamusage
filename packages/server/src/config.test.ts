import { describe, expect, test } from "vitest";
import { parseServerConfig } from "./config.js";

describe("parseServerConfig", () => {
  test("defaults", () => {
    expect(parseServerConfig({}, [])).toEqual({
      port: 8787,
      host: "0.0.0.0",
      dataDir: "/data",
      inviteCodeFromEnv: undefined,
      demo: false,
      trustedProxies: 0,
      mode: "self-hosted",
      hosted: undefined,
    });
  });

  test("reads the environment and flags", () => {
    const c = parseServerConfig(
      { PORT: "9000", TEAMUSAGE_DATA_DIR: "/x", TEAMUSAGE_INVITE_CODE: "abcdefghij123456", TEAMUSAGE_TRUSTED_PROXIES: "2", TEAMUSAGE_HOST: "127.0.0.1" },
      [],
    );
    expect(c).toMatchObject({ port: 9000, dataDir: "/x", inviteCodeFromEnv: "abcdefghij123456", trustedProxies: 2, host: "127.0.0.1" });
    expect(parseServerConfig({ TEAMUSAGE_DEMO: "1" }, []).demo).toBe(true);
    expect(parseServerConfig({}, ["--demo"]).demo).toBe(true);
    expect(parseServerConfig({ TEAMUSAGE_DEMO: "0" }, []).demo).toBe(false);
    expect(parseServerConfig({ TEAMUSAGE_INVITE_CODE: "" }, []).inviteCodeFromEnv).toBeUndefined();
  });

  test("rejects a weak or malformed operator invite code without echoing it", () => {
    const msg = "TEAMUSAGE_INVITE_CODE must be 16 to 128 characters with no spaces";
    for (const [name, v] of [
      ["too short", "s".repeat(15)],
      ["too long", "l".repeat(129)],
      ["space", "has a space-0123456789"],
      ["tab", "tab\tinside-0123456789"],
      ["newline", "line\nbreak-0123456789"],
      ["control", "ctl\x01char-0123456789"],
    ] as const) {
      let err: Error | undefined;
      try {
        parseServerConfig({ TEAMUSAGE_INVITE_CODE: v }, []);
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message, name).toBe(msg);
    }
    expect(parseServerConfig({ TEAMUSAGE_INVITE_CODE: "x".repeat(16) }, []).inviteCodeFromEnv).toBe("x".repeat(16));
    expect(parseServerConfig({ TEAMUSAGE_INVITE_CODE: "x".repeat(128) }, []).inviteCodeFromEnv).toBe("x".repeat(128));
  });

  test("rejects invalid PORT and TEAMUSAGE_TRUSTED_PROXIES with a fixed message", () => {
    for (const PORT of ["0", "65536", "-1", "80.5", "abc", " 80", "1e3", "0x50"]) {
      expect(() => parseServerConfig({ PORT }, []), PORT).toThrow("PORT must be an integer from 1 to 65535");
    }
    for (const v of ["-1", "11", "1.5", "x", "2 "]) {
      expect(() => parseServerConfig({ TEAMUSAGE_TRUSTED_PROXIES: v }, []), v).toThrow(
        "TEAMUSAGE_TRUSTED_PROXIES must be an integer from 0 to 10",
      );
    }
    expect(parseServerConfig({ PORT: "65535", TEAMUSAGE_TRUSTED_PROXIES: "10" }, [])).toMatchObject({ port: 65535, trustedProxies: 10 });
    expect(() => parseServerConfig({ PORT: "bad-secret" }, [])).toThrow(/^PORT must be an integer from 1 to 65535$/);
  });
});

const HOSTED = {
  TEAMUSAGE_MODE: "hosted",
  TEAMUSAGE_PUBLIC_URL: "https://teamusage.example",
  TEAMUSAGE_GITHUB_CLIENT_ID: "id",
  TEAMUSAGE_GITHUB_CLIENT_SECRET: "secret",
  TEAMUSAGE_CODE_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const URL_MESSAGE = "TEAMUSAGE_PUBLIC_URL must be an https origin such as https://example.com (http only for localhost)";
const GITHUB_MESSAGE = "hosted mode needs TEAMUSAGE_GITHUB_CLIENT_ID and TEAMUSAGE_GITHUB_CLIENT_SECRET";
const KEY_MESSAGE = "TEAMUSAGE_CODE_KEY must be 32 random bytes in base64 (openssl rand -base64 32)";
const TEAMS_MESSAGE = "TEAMUSAGE_MAX_TEAMS must be an integer from 1 to 100000";
const publicUrl = (value: string): string => parseServerConfig({ ...HOSTED, TEAMUSAGE_PUBLIC_URL: value }, []).hosted!.publicUrl;

describe("hosted settings", () => {
  test("no mode is self-hosted and reads no hosted setting", () => {
    expect(parseServerConfig({ TEAMUSAGE_GITHUB_CLIENT_ID: "x" }, [])).toMatchObject({ mode: "self-hosted", hosted: undefined });
    const malformed = { TEAMUSAGE_PUBLIC_URL: "not a url", TEAMUSAGE_CODE_KEY: "!!", TEAMUSAGE_MAX_TEAMS: "0" };
    expect(parseServerConfig(malformed, [])).toMatchObject({ mode: "self-hosted", hosted: undefined });
    expect(parseServerConfig({ TEAMUSAGE_MODE: "" }, []).mode).toBe("self-hosted");
    expect(parseServerConfig({ TEAMUSAGE_MODE: "self-hosted" }, []).mode).toBe("self-hosted");
  });

  test("hosted mode reads its settings", () => {
    expect(parseServerConfig(HOSTED, []).hosted).toEqual({
      publicUrl: "https://teamusage.example",
      githubClientId: "id",
      githubClientSecret: "secret",
      codeKey: Buffer.alloc(32, 7),
      maxTeams: 200,
    });
    expect(parseServerConfig(HOSTED, []).mode).toBe("hosted");
  });

  test("the public url is kept as an origin", () => {
    expect(publicUrl("http://localhost:8787/")).toBe("http://localhost:8787");
    expect(publicUrl("https://teamusage.example/")).toBe("https://teamusage.example");
    expect(publicUrl("https://teamusage.example:8443")).toBe("https://teamusage.example:8443");
  });

  test("http is accepted for loopback hosts only", () => {
    expect(publicUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(publicUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
    expect(() => publicUrl("http://10.0.0.1:8787")).toThrow(URL_MESSAGE);
  });

  test.each([
    ["a query", "https://teamusage.example/?a=1"],
    ["a fragment", "https://teamusage.example/#x"],
    ["a user name", "https://user@teamusage.example"],
    ["a password", "https://:pw@teamusage.example"],
    ["not a url", "teamusage.example"],
  ])("the public url refuses %s", (_name, value) => {
    expect(() => publicUrl(value)).toThrow(URL_MESSAGE);
  });

  test.each([
    ["TEAMUSAGE_MODE", "public", "TEAMUSAGE_MODE must be self-hosted or hosted"],
    ["TEAMUSAGE_PUBLIC_URL", "http://teamusage.example", URL_MESSAGE],
    ["TEAMUSAGE_PUBLIC_URL", "https://teamusage.example/app", URL_MESSAGE],
    ["TEAMUSAGE_PUBLIC_URL", "https://user:pw@teamusage.example", URL_MESSAGE],
    ["TEAMUSAGE_GITHUB_CLIENT_SECRET", "", GITHUB_MESSAGE],
    ["TEAMUSAGE_CODE_KEY", Buffer.alloc(31).toString("base64"), KEY_MESSAGE],
    ["TEAMUSAGE_CODE_KEY", "not base64 !!", KEY_MESSAGE],
    ["TEAMUSAGE_MAX_TEAMS", "0", TEAMS_MESSAGE],
    ["TEAMUSAGE_INVITE_CODE", "a".repeat(24), "TEAMUSAGE_INVITE_CODE is not used in hosted mode; each team has its own code"],
  ])("hosted mode refuses a bad %s", (key, value, message) => {
    expect(() => parseServerConfig({ ...HOSTED, [key]: value }, [])).toThrow(message);
  });

  test("hosted mode refuses an invite code before judging its format", () => {
    expect(() => parseServerConfig({ ...HOSTED, TEAMUSAGE_INVITE_CODE: "short" }, [])).toThrow(
      "TEAMUSAGE_INVITE_CODE is not used in hosted mode; each team has its own code",
    );
  });

  test("hosted mode refuses demo mode", () => {
    expect(() => parseServerConfig(HOSTED, ["--demo"])).toThrow("demo mode is not available in hosted mode");
  });

  test("hosted mode with every hosted setting missing fails with a fixed message", () => {
    expect(() => parseServerConfig({ TEAMUSAGE_MODE: "hosted" }, [])).toThrow(URL_MESSAGE);
  });

  test.each(["TEAMUSAGE_GITHUB_CLIENT_ID", "TEAMUSAGE_GITHUB_CLIENT_SECRET"])("%s refuses whitespace, control characters and length over 200", (key) => {
    for (const value of ["has space", "tab\tinside", "line\nbreak", "ctl\x01char", "x".repeat(201), ""]) {
      expect(() => parseServerConfig({ ...HOSTED, [key]: value }, []), JSON.stringify(value)).toThrow(GITHUB_MESSAGE);
    }
    expect(parseServerConfig({ ...HOSTED, [key]: "x".repeat(200) }, []).hosted).toBeDefined();
  });

  test("the code key must be strict base64 of exactly 32 bytes", () => {
    const good = Buffer.alloc(32, 9).toString("base64");
    expect(parseServerConfig({ ...HOSTED, TEAMUSAGE_CODE_KEY: good }, []).hosted!.codeKey).toEqual(Buffer.alloc(32, 9));
    for (const value of [
      Buffer.alloc(33).toString("base64"),
      `${good.slice(0, 10)}!${good.slice(10)}`,
      good.slice(0, -1),
      good.replace(/=+$/, ""),
      `${good.slice(0, -2)}l=`,
      ` ${good}`,
      "",
    ]) {
      expect(() => parseServerConfig({ ...HOSTED, TEAMUSAGE_CODE_KEY: value }, []), value).toThrow(KEY_MESSAGE);
    }
  });

  test("the team limit is an integer from 1 to 100000, and empty means unset", () => {
    expect(parseServerConfig({ ...HOSTED, TEAMUSAGE_MAX_TEAMS: "" }, []).hosted!.maxTeams).toBe(200);
    expect(parseServerConfig({ ...HOSTED, TEAMUSAGE_MAX_TEAMS: "1" }, []).hosted!.maxTeams).toBe(1);
    expect(parseServerConfig({ ...HOSTED, TEAMUSAGE_MAX_TEAMS: "100000" }, []).hosted!.maxTeams).toBe(100000);
    for (const value of ["1.5", "abc", "100001", "-1"]) {
      expect(() => parseServerConfig({ ...HOSTED, TEAMUSAGE_MAX_TEAMS: value }, []), value).toThrow(TEAMS_MESSAGE);
    }
  });

  test("no message repeats a value", () => {
    const secret = "s3cr3t-value-that-must-not-leak";
    for (const key of Object.keys(HOSTED)) {
      const run = () => parseServerConfig({ ...HOSTED, [key]: `${secret} ` }, []);
      expect(run, key).toThrow();
      expect(run, key).not.toThrow(secret);
    }
  });
});
