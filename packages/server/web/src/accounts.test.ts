import { describe, expect, test } from "vitest";
import { accountName } from "./accounts.js";

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
