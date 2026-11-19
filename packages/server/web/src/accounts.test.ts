import { describe, expect, test } from "vitest";
import { accountName, accountPlanName, planName, planShort } from "./accounts.js";

describe("accountName", () => {
  test("the agreed display names in English", () => {
    expect(accountName("team:Devcats", "en")).toBe("Team · Devcats");
    expect(accountName("enterprise:Acme", "en")).toBe("Enterprise · Acme");
    expect(accountName("team:", "en")).toBe("Team");
    expect(accountName("enterprise:", "en")).toBe("Enterprise");
    expect(accountName("personal", "en")).toBe("Personal");
    expect(accountName("api", "en")).toBe("API key");
    expect(accountName("unknown", "en")).toBe("Unknown");
  });

  test("the agreed display names in Russian", () => {
    expect(accountName("team:Devcats", "ru")).toBe("Команда · Devcats");
    expect(accountName("enterprise:Acme", "ru")).toBe("Enterprise · Acme");
    expect(accountName("team:", "ru")).toBe("Команда");
    expect(accountName("enterprise:", "ru")).toBe("Enterprise");
    expect(accountName("personal", "ru")).toBe("Личный");
    expect(accountName("api", "ru")).toBe("API-ключ");
    expect(accountName("unknown", "ru")).toBe("Неизвестно");
  });

  test("the org is kept whole after the first colon and never guessed into another kind", () => {
    expect(accountName("team:a:b", "en")).toBe("Team · a:b");
    expect(accountName("team:<img src=x onerror=alert(1)>", "en")).toBe("Team · <img src=x onerror=alert(1)>");
    // A malformed key is never shown as Personal or Team.
    for (const key of ["boss", "Personal", "team", "personal:x", "__proto__", ""]) expect(accountName(key, "en")).toBe("Unknown");
  });
});

describe("Codex and Other agents names", () => {
  test("chatgpt kinds and other", () => {
    expect(accountName("chatgpt:personal", "en")).toBe("Personal · ChatGPT");
    expect(accountName("chatgpt:personal", "ru")).toBe("Личный · ChatGPT");
    expect(accountName("chatgpt:team", "en")).toBe("Team · ChatGPT");
    expect(accountName("chatgpt:team", "ru")).toBe("Команда · ChatGPT");
    expect(accountName("chatgpt:enterprise", "en")).toBe("Enterprise · ChatGPT");
    expect(accountName("chatgpt:api", "en")).toBe("API key · ChatGPT");
    expect(accountName("chatgpt:api", "ru")).toBe("API-ключ · ChatGPT");
    expect(accountName("chatgpt:unknown", "en")).toBe("Unknown");
    expect(accountName("other", "en")).toBe("Other agents");
    expect(accountName("other", "ru")).toBe("Другие агенты");
  });
});

describe("planName, planShort, accountPlanName", () => {
  test("full plan names", () => {
    const en = ["free", "pro", "max_5x", "max_20x", "team_standard", "team_premium", "enterprise"].map((p) => planName(`claude:${p}`, "en"));
    expect(en).toEqual(["Claude Free", "Claude Pro", "Claude Max 5x", "Claude Max 20x", "Claude Team Standard", "Claude Team Premium", "Claude Enterprise"]);
    const codex = ["free", "plus", "pro", "business", "enterprise", "edu"].map((p) => planName(`codex:${p}`, "ru"));
    expect(codex).toEqual(["ChatGPT Free", "ChatGPT Plus", "ChatGPT Pro", "ChatGPT Business", "ChatGPT Enterprise", "ChatGPT Edu"]);
    expect(planName("none", "en")).toBe("No plan");
    expect(planName("none", "ru")).toBe("Без тарифа");
    for (const bad of ["claude:gold", "codex:max_5x", "x", "", "__proto__"]) expect(planName(bad, "en")).toBe("No plan");
  });

  test("short names; empty for enterprise, none and malformed", () => {
    expect(["claude:free", "claude:pro", "claude:max_5x", "claude:max_20x", "claude:team_standard", "claude:team_premium", "codex:plus", "codex:business", "codex:edu"].map(planShort)).toEqual([
      "Free", "Pro", "Max 5x", "Max 20x", "Standard", "Premium", "Plus", "Business", "Edu",
    ]);
    for (const k of ["claude:enterprise", "codex:enterprise", "none", "junk", ""]) expect(planShort(k)).toBe("");
  });

  test("account and plan together", () => {
    expect(accountPlanName("team:O!Bank Team", "claude:team_premium", "en")).toBe("Team · O!Bank Team · Premium");
    expect(accountPlanName("chatgpt:personal", "codex:plus", "en")).toBe("Personal · ChatGPT · Plus");
    expect(accountPlanName("enterprise:Acme", "claude:enterprise", "en")).toBe("Enterprise · Acme");
    expect(accountPlanName("unknown", "none", "en")).toBe("Unknown");
    expect(accountPlanName("team:<img src=x onerror=alert(1)>", "claude:pro", "en")).toBe("Team · <img src=x onerror=alert(1)> · Pro");
  });
});
