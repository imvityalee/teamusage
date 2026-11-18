import { readFileSync } from "node:fs";
import { presetRange, type Stats } from "@teamusage/shared";
import { Window } from "happy-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { localIsoDate } from "./format.js";
import { LANG_KEY } from "./i18n.js";
import { memberStatsFixture, statsFixture } from "./test-fixtures.js";

const PAGE = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const BODY = /<body>([\s\S]*)<\/body>/.exec(PAGE)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "") ?? "";

type Reply = Response | Error | (() => Promise<Response>);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const unauthorized = () => json({ error: "unauthorized" }, 401);

let win: Window;
let doc: Document;
let calls: { url: string; init: RequestInit }[];
let replies: Reply[];

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => doc.querySelector(sel) as T;
const keys = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i));
const range = (days: 30 | 90 | 180) => presetRange(days, localIsoDate(new Date()));
const statsUrl = (r: { from: string; to: string }) => `/api/stats?from=${r.from}&to=${r.to}`;

const boot = (...first: Reply[]) => bootAt("http://localhost:8787/", ...first);

async function bootAt(url: string, ...first: Reply[]): Promise<void> {
  win = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = BODY; // the page's own static markup
  calls = [];
  replies = [...first];
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", win.navigator);
  vi.stubGlobal("localStorage", win.localStorage);
  vi.stubGlobal("sessionStorage", win.sessionStorage);
  vi.stubGlobal("location", win.location);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = replies.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    }),
  );
  vi.resetModules();
  await import("./main.js");
  await flush();
}

function submitLogin(code: string): void {
  $<HTMLInputElement>("#invite").value = code;
  $("#login-form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await win?.happyDOM.close();
});

describe("login", () => {
  test("a 401 shows the login form; signing in loads the stats and leaves the code nowhere", async () => {
    await boot(unauthorized());
    expect($("#login").hidden).toBe(false);
    expect($("#stats").hidden).toBe(true);
    const invite = $<HTMLInputElement>("#invite");
    expect(invite.type).toBe("password");
    expect(invite.getAttribute("autocomplete")).toBe("off");
    expect(doc.querySelector('label[for="invite"]')).not.toBeNull();

    const code = "s3cret-invite-code-0123";
    replies.push(new Response(null, { status: 204 }), json(statsFixture()));
    submitLogin(code);
    expect(invite.value).toBe("");
    await flush();

    expect(calls.map((c) => c.url)).toEqual([statsUrl(range(90)), "/api/login", statsUrl(range(90))]);
    const loginCall = calls[1] as { init: RequestInit };
    expect(loginCall.init.method).toBe("POST");
    expect(loginCall.init.credentials).toBe("same-origin");
    expect(JSON.parse(loginCall.init.body as string)).toEqual({ inviteCode: code });
    for (const c of calls) expect(c.init.credentials).toBe("same-origin");

    expect($("#login").hidden).toBe(true);
    expect($("#stats").hidden).toBe(false);
    expect(doc.querySelectorAll("#stats .tile")).toHaveLength(4);

    // The code is not kept anywhere the page can write.
    const stored = keys(win.localStorage as unknown as Storage).filter((k) => k !== LANG_KEY);
    expect(stored).toEqual([]);
    expect(win.sessionStorage.length).toBe(0);
    expect(doc.cookie).toBe("");
    expect(win.location.href).toBe("http://localhost:8787/");
    expect(doc.documentElement.outerHTML).not.toContain(code);
  });

  test("a wrong code and too many attempts are explained", async () => {
    await boot(unauthorized());
    replies.push(json({ error: "invalid invite code" }, 403));
    submitLogin("wrong-code-wrong-code");
    await flush();
    expect($("#login-msg").hidden).toBe(false);
    expect($("#login-msg").textContent).toBe("Wrong invite code.");

    replies.push(json({ error: "too many attempts" }, 429, { "Retry-After": "120" }));
    submitLogin("wrong-code-wrong-code");
    await flush();
    expect($("#login-msg").textContent).toBe("Too many attempts. Try again in 2 minutes.");
    expect($("#login").hidden).toBe(false);
    expect($<HTMLInputElement>("#invite").value).toBe("");
  });
});

describe("range", () => {
  test("presets and a valid custom range reload; a too long range is refused without a request", async () => {
    await boot(json(statsFixture()));
    expect(calls.map((c) => c.url)).toEqual([statsUrl(range(90))]);
    const pressed = () => [...doc.querySelectorAll("#range button")].map((b) => b.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["false", "true", "false"]);

    replies.push(json(statsFixture()));
    $('#range button[data-days="30"]').click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(30)));
    expect(pressed()).toEqual(["true", "false", "false"]);
    expect($<HTMLInputElement>("#from").value).toBe(range(30).from);

    const from = $<HTMLInputElement>("#from");
    const to = $<HTMLInputElement>("#to");
    from.value = "2024-01-01";
    to.value = "2026-01-01";
    to.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    await flush();
    expect(calls).toHaveLength(2);
    expect($("#range-msg").hidden).toBe(false);
    expect($("#range-msg").textContent).toBe("A range can be at most 730 days.");

    replies.push(json(statsFixture()));
    from.value = "2026-01-01";
    from.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    await flush();
    expect(calls.at(-1)?.url).toBe("/api/stats?from=2026-01-01&to=2026-01-01");
    expect($("#range-msg").hidden).toBe(true);
    expect(pressed()).toEqual(["false", "false", "false"]);
  });

  test("while loading, the previous numbers stay and are dimmed", async () => {
    await boot(json(statsFixture()));
    let release: (r: Response) => void = () => {};
    replies.push(() => new Promise<Response>((r) => (release = r)));
    $('#range button[data-days="180"]').click();
    await flush();
    expect($("#stats").getAttribute("aria-busy")).toBe("true");
    expect($("#stats").classList.contains("loading")).toBe(true);
    expect(doc.querySelectorAll("#stats .tile")).toHaveLength(4);
    release(json(statsFixture()));
    await flush();
    expect($("#stats").getAttribute("aria-busy")).toBe("false");
    expect($("#stats").classList.contains("loading")).toBe(false);
  });

  test("a network failure keeps the numbers and offers a retry", async () => {
    await boot(json(statsFixture()));
    replies.push(new TypeError("offline"));
    $('#range button[data-days="30"]').click();
    await flush();
    expect($("#status").hidden).toBe(false);
    expect($("#status-text").textContent).toBe("Could not reach the server.");
    expect(doc.querySelectorAll("#stats .tile")).toHaveLength(4);

    replies.push(json(statsFixture()));
    $("#retry").click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(30)));
    expect($("#status").hidden).toBe(true);
  });
});

describe("language", () => {
  test("switching language re-renders every string, stores only the choice and does not refetch", async () => {
    await boot(json(statsFixture()));
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.title).toBe("teamusage — team usage");
    $('#lang button[data-lang="ru"]').click();
    await flush();
    expect(calls).toHaveLength(1);
    expect(doc.documentElement.lang).toBe("ru");
    expect(doc.title).toBe("teamusage — статистика команды");
    expect($('#lang button[data-lang="ru"]').getAttribute("aria-pressed")).toBe("true");
    expect($('#range button[data-days="90"]').textContent).toBe("3 месяца");
    expect($("#stats .tile .k").textContent).toBe("Всего токенов");
    expect($('label[for="invite"]').textContent).toBe("Инвайт-код");
    expect(keys(win.localStorage as unknown as Storage)).toEqual([LANG_KEY]);
    expect(win.localStorage.getItem(LANG_KEY)).toBe("ru");
  });
});

const memberUrl = (r: { from: string; to: string }, id: number) => `${statsUrl(r)}&member=${id}`;
const memberRows = () => [...doc.querySelectorAll("#members tbody tr")].map((r) => r.querySelector(".who a")?.textContent);

function typeQuery(value: string): void {
  const input = $<HTMLInputElement>("#member-search");
  input.value = value;
  input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
}

async function goTo(hash: string): Promise<void> {
  win.location.hash = hash;
  await flush();
}

describe("member search", () => {
  test("typing filters the loaded rows without a request and keeps the query nowhere", async () => {
    await boot(json(statsFixture()));
    expect(memberRows()).toHaveLength(3);
    typeQuery("NGUY");
    await flush();
    expect(memberRows()).toEqual(["Bao Nguyen"]);
    expect($("#members-count").textContent).toBe("1 of 3 members");
    typeQuery("zzz");
    await flush();
    expect(memberRows()).toEqual([]);
    expect($("#members-count").textContent).toBe("No members match");
    typeQuery("");
    await flush();
    expect(memberRows()).toHaveLength(3);
    expect($("#members-count").hidden).toBe(true);

    expect(calls).toHaveLength(1);
    expect(keys(win.localStorage as unknown as Storage)).toEqual([]);
    expect(win.sessionStorage.length).toBe(0);
    expect(win.location.href).toBe("http://localhost:8787/");
  });

  test("the query survives a range change and a language switch", async () => {
    await boot(json(statsFixture()));
    typeQuery("carla");
    replies.push(json(statsFixture()));
    $('#range button[data-days="30"]').click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(30)));
    expect(calls.at(-1)?.url).not.toContain("carla");
    expect($<HTMLInputElement>("#member-search").value).toBe("carla");
    expect(memberRows()).toEqual(["Carla Mendes"]);
    $('#lang button[data-lang="ru"]').click();
    await flush();
    expect($("#members-count").textContent).toBe("1 из 3 участников");
    expect(memberRows()).toEqual(["Carla Mendes"]);
  });

  test("the search box keeps focus when a load finishes while typing", async () => {
    await boot(json(statsFixture()));
    let release: (r: Response) => void = () => {};
    replies.push(() => new Promise<Response>((r) => (release = r)));
    $('#range button[data-days="30"]').click();
    $<HTMLInputElement>("#member-search").focus();
    typeQuery("al");
    release(json(statsFixture()));
    await flush();
    expect(doc.activeElement?.id).toBe("member-search");
    expect($<HTMLInputElement>("#member-search").value).toBe("al");
  });
});

describe("member page", () => {
  test("clicking a member name opens their page with the member's stats", async () => {
    await boot(json(statsFixture()));
    replies.push(json(memberStatsFixture()));
    $('#members a[href="#/member/1"]').click();
    await flush();
    expect(win.location.hash).toBe("#/member/1");
    expect(calls.at(-1)?.url).toBe(memberUrl(range(90), 1));
    expect(calls.at(-1)?.init.credentials).toBe("same-origin");
    expect($("#member-heading").textContent).toBe("Alice Archer");
    expect(doc.title).toBe("Alice Archer — teamusage");
    expect(doc.querySelectorAll("#machines li")).toHaveLength(3);
    expect(doc.querySelector("#members")).toBeNull();
    expect(doc.querySelector("#member-search")).toBeNull();
  });

  test("a hashchange loads that member; going back to the team clears the query and drops the member", async () => {
    await boot(json(statsFixture()));
    typeQuery("alice");
    replies.push(json({ ...memberStatsFixture(), members: [{ ...statsFixture().members[1], id: 2 }] }));
    await goTo("#/member/2");
    expect(calls.at(-1)?.url).toBe(memberUrl(range(90), 2));
    expect(doc.title).toBe("Bao Nguyen — teamusage");

    replies.push(json(statsFixture()));
    $("a.back").click();
    await flush();
    expect(win.location.hash).toBe("#/");
    expect(calls.at(-1)?.url).toBe(statsUrl(range(90)));
    expect(doc.title).toBe("teamusage — team usage");
    expect($<HTMLInputElement>("#member-search").value).toBe("");
    expect(memberRows()).toHaveLength(3);
  });

  test("while the member page loads, the previous view stays, dimmed", async () => {
    await boot(json(statsFixture()));
    let release: (r: Response) => void = () => {};
    replies.push(() => new Promise<Response>((r) => (release = r)));
    await goTo("#/member/1");
    expect($("#stats").classList.contains("loading")).toBe(true);
    expect(doc.querySelectorAll("#members tbody tr")).toHaveLength(3);
    release(json(memberStatsFixture()));
    await flush();
    expect($("#stats").classList.contains("loading")).toBe(false);
    expect($("#member-heading").textContent).toBe("Alice Archer");
  });

  test("range and language keep working on the member page", async () => {
    await bootAt("http://localhost:8787/#/member/1", json(memberStatsFixture()));
    expect(calls.map((c) => c.url)).toEqual([memberUrl(range(90), 1)]);
    replies.push(json(memberStatsFixture()));
    $('#range button[data-days="180"]').click();
    await flush();
    expect(calls.at(-1)?.url).toBe(memberUrl(range(180), 1));
    $('#lang button[data-lang="ru"]').click();
    await flush();
    expect(calls).toHaveLength(2);
    expect($("a.back").textContent).toBe("Все участники");
    expect(doc.title).toBe("Alice Archer — teamusage");
  });

  test("a malformed member fragment is the team view and sends no member", async () => {
    for (const hash of ["#/member/01", "#/member/1%22%3E%3Cimg%3E", "#/member/12345678901", "#/member/1/x"]) {
      await bootAt(`http://localhost:8787/${hash}`, json(statsFixture()));
      expect(calls.map((c) => c.url)).toEqual([statsUrl(range(90))]);
      expect(doc.querySelector("#members")).not.toBeNull();
      vi.unstubAllGlobals();
      await win.happyDOM.close();
    }
  });

  test("an unknown member shows not found with the link back", async () => {
    await boot(json(statsFixture()));
    replies.push(json({ error: "member not found" }, 404));
    await goTo("#/member/999999");
    expect(calls.at(-1)?.url).toBe(memberUrl(range(90), 999999));
    expect($("#stats .empty").textContent).toBe("Member not found");
    expect($("#page-head a.back").getAttribute("href")).toBe("#/");
    expect($("#status").hidden).toBe(true);
    expect(doc.querySelector("#members")).toBeNull();
    $('#lang button[data-lang="ru"]').click();
    expect($("#stats .empty").textContent).toBe("Участник не найден");
  });

  test("other errors on the member page use the status line", async () => {
    await boot(json(statsFixture()));
    replies.push(json({ error: "<b>boom</b>" }, 500));
    await goTo("#/member/1");
    expect($("#status").hidden).toBe(false);
    expect($("#status-text").textContent).toBe("Could not load the statistics: <b>boom</b>");
    expect(doc.querySelector("#status b")).toBeNull();
  });
});

describe("out-of-order answers", () => {
  const pending = () => {
    let release: (r: Response) => void = () => {};
    const reply = () => new Promise<Response>((r) => (release = r));
    return { reply, release: (r: Response) => release(r) };
  };
  const bao = () => ({
    ...memberStatsFixture(),
    members: [{ ...(statsFixture().members[1] as Stats["members"][number]) }],
    machines: [{ label: "bao-desktop", lastSyncAt: "2026-11-18T12:00:00.000Z" }],
    models: [memberStatsFixture().models[1] as Stats["models"][number]],
  });

  test("a slow answer for an earlier member never replaces the later member's page", async () => {
    await boot(json(statsFixture()));
    const slow = pending();
    replies.push(slow.reply);
    await goTo("#/member/1");
    replies.push(json(bao()));
    await goTo("#/member/2");
    expect(calls.map((c) => c.url).slice(-2)).toEqual([memberUrl(range(90), 1), memberUrl(range(90), 2)]);
    expect($("#member-heading").textContent).toBe("Bao Nguyen");

    slow.release(json(memberStatsFixture()));
    await flush();
    expect($("#member-heading").textContent).toBe("Bao Nguyen");
    expect(doc.title).toBe("Bao Nguyen — teamusage");
    expect([...doc.querySelectorAll("#machines .machine-label")].map((el) => el.textContent)).toEqual(["bao-desktop"]);
    expect([...doc.querySelectorAll("#models tbody tr")].map((r) => r.querySelectorAll("td")[1]?.textContent)).toEqual(["gpt-5-codex"]);
    expect($("#stats").classList.contains("loading")).toBe(false);
  });

  test("a member answer that arrives after going back to the team is ignored", async () => {
    await boot(json(statsFixture()));
    const slow = pending();
    replies.push(slow.reply);
    await goTo("#/member/1");
    replies.push(json(statsFixture()));
    await goTo("#/");
    expect(calls.at(-1)?.url).toBe(statsUrl(range(90)));

    slow.release(json(memberStatsFixture()));
    await flush();
    expect(doc.querySelectorAll("#members tbody tr")).toHaveLength(3);
    expect(doc.querySelector("#member-heading")).toBeNull();
    expect(doc.querySelector("#member-search")).not.toBeNull();
    expect(doc.title).toBe("teamusage — team usage");
    expect($("#stats").classList.contains("loading")).toBe(false);
  });
});

describe("page title", () => {
  test("a member name with markup reaches the title as literal text and creates no element", async () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const stats = memberStatsFixture({ name: evil, email: evil, agent: "aider", model: "some-model" });
    await bootAt("http://localhost:8787/#/member/1", json(stats));
    expect(doc.title).toBe(`${evil} — teamusage`);
    expect(doc.querySelector("title")?.textContent).toBe(`${evil} — teamusage`);
    expect(doc.querySelector("title")?.children).toHaveLength(0);
    // The only images are the fixed agent logos.
    expect([...doc.querySelectorAll("img")].every((img) => (img.getAttribute("src") ?? "").startsWith("/agents/"))).toBe(true);
    expect($("#member-heading").textContent).toBe(evil);
  });
});

describe("filters", () => {
  const withFilters = (url: string, params: [string, string][]) =>
    params.length === 0 ? url : `${url}&${new URLSearchParams(params).toString()}`;
  const open = (kind: "agents" | "models") => $(`#${kind}-btn`).click();
  const rowBoxes = (kind: "agents" | "models") =>
    [...doc.querySelectorAll<HTMLInputElement>(`#${kind}-pop label.pop-row input`)].filter((b) => !(b.closest("li") as HTMLElement).hidden);
  function tick(box: HTMLInputElement | undefined): void {
    if (!box) throw new Error("no checkbox");
    box.checked = !box.checked;
    box.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
  }
  const key = (k: string, target: EventTarget = doc.activeElement ?? doc.body) =>
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event);
  const noStorage = () => {
    expect(keys(win.localStorage as unknown as Storage).filter((k) => k !== LANG_KEY)).toEqual([]);
    expect(win.sessionStorage.length).toBe(0);
    expect(doc.cookie).toBe("");
  };

  test("ticking agents and a model asks again with repeated agent and model parameters; Clear filters drops them", async () => {
    await boot(json(statsFixture()));
    open("agents");
    expect($("#agents-btn").getAttribute("aria-expanded")).toBe("true");
    replies.push(json(statsFixture()));
    tick(rowBoxes("agents")[1]); // Codex
    await flush();
    expect(calls.at(-1)?.url).toBe(withFilters(statsUrl(range(90)), [["agent", "codex"]]));
    // The popover stays open for more choices and shows the selection.
    expect($("#agents-btn").getAttribute("aria-expanded")).toBe("true");
    expect(rowBoxes("agents").map((b) => b.checked)).toEqual([false, true, false]);
    expect($("#agents-btn").textContent?.trim()).toBe("1 agent");

    replies.push(json(statsFixture()));
    tick(rowBoxes("agents")[0]); // Claude Code
    await flush();
    expect(calls.at(-1)?.url).toBe(withFilters(statsUrl(range(90)), [["agent", "codex"], ["agent", "claude"]]));

    open("models");
    expect($("#agents-btn").getAttribute("aria-expanded")).toBe("false");
    expect(doc.querySelectorAll(".popover")).toHaveLength(1);
    replies.push(json(statsFixture()));
    tick(rowBoxes("models")[1]); // claude-opus-4-1
    await flush();
    expect(calls.at(-1)?.url).toBe(
      withFilters(statsUrl(range(90)), [["agent", "codex"], ["agent", "claude"], ["model", "claude:claude-opus-4-1"]]),
    );
    expect([...doc.querySelectorAll("#chips button.chip")].map((c) => c.textContent?.trim())).toEqual(["Codex", "Claude Code", "claude-opus-4-1"]);
    expect($("#chips").hidden).toBe(false);
    expect([...doc.querySelectorAll(".tile .k")].slice(0, 2).map((k) => k.textContent)).toEqual(["Total tokens · filtered", "Estimated cost · filtered"]);

    replies.push(json(statsFixture()));
    $("#clear-filters").click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(90)));
    expect($("#chips").hidden).toBe(true);
    expect(doc.querySelector("#clear-filters")).toBeNull();
    expect(doc.querySelector(".popover")).toBeNull();
    expect($(".tile .k").textContent).toBe("Total tokens");
    noStorage();
    expect(win.location.href).toBe("http://localhost:8787/");
  });

  test("removing a chip removes that filter", async () => {
    await boot(json(statsFixture()));
    open("agents");
    replies.push(json(statsFixture()), json(statsFixture()));
    tick(rowBoxes("agents")[1]);
    await flush();
    tick(rowBoxes("agents")[0]);
    await flush();
    replies.push(json(statsFixture()));
    (doc.querySelector("#chips button.chip") as HTMLButtonElement).click();
    await flush();
    expect(calls.at(-1)?.url).toBe(withFilters(statsUrl(range(90)), [["agent", "claude"]]));
  });

  /**
   * What the server answers for member 1 when that member used Claude Code only: the member's own `available`,
   * and the numbers narrowed by the agents asked for (`[]` = no filter).
   */
  function claudeOnlyMember(asked: string[]): Stats {
    const base = memberStatsFixture();
    const matches = asked.length === 0 || asked.includes("claude");
    const daily = base.daily.map((d): Stats["daily"][number] => ({ date: d.date, byAgent: matches ? { claude: d.byAgent.claude ?? 0 } : {} }));
    const tokens = matches ? 55_000 : 0;
    return {
      ...base,
      totals: { tokens, costUsd: matches ? 11 : 0, activeMembers: matches ? 1 : 0, memberCount: 1 },
      daily,
      members: base.members.map((m): Stats["members"][number] => ({ ...m, tokens, costUsd: matches ? 11 : 0, byAgent: matches ? { claude: tokens } : {} })),
      models: matches ? base.models.filter((m) => m.agent === "claude") : [],
      available: {
        agents: ["claude"],
        models: [
          { agent: "claude", model: "claude-sonnet-4-5", tokens: 30_000 },
          { agent: "claude", model: "claude-opus-4-1", tokens: 25_000 },
        ],
      },
    };
  }
  const chipTexts = () => [...doc.querySelectorAll("#chips button.chip")].map((c) => c.textContent?.trim());

  test("the filter survives a range change and a language switch without a new request for the language", async () => {
    await boot(json(statsFixture()));
    open("agents");
    replies.push(json(statsFixture()));
    tick(rowBoxes("agents")[1]);
    await flush();

    replies.push(json(statsFixture()));
    $('#range button[data-days="30"]').click();
    await flush();
    expect(calls.at(-1)?.url).toBe(withFilters(statsUrl(range(30)), [["agent", "codex"]]));

    const before = calls.length;
    $('#lang button[data-lang="ru"]').click();
    await flush();
    expect(calls).toHaveLength(before);
    expect($("#agents-btn").textContent?.trim()).toBe("1 агент");
    expect($(".tile .k").textContent).toBe("Всего токенов · с фильтром");
    noStorage();
  });

  test("on the team view, a range where the selection no longer exists drops it and asks again", async () => {
    await boot(json(statsFixture()));
    open("agents");
    replies.push(json(statsFixture()));
    tick(rowBoxes("agents")[1]);
    await flush();
    const noCodex = { ...statsFixture(), available: { agents: ["claude"], models: [{ agent: "claude", model: "claude-opus-4-1", tokens: 5 }] } };
    replies.push(json(noCodex), json(noCodex));
    $('#range button[data-days="180"]').click();
    await flush();
    expect(calls.slice(-2).map((c) => c.url)).toEqual([withFilters(statsUrl(range(180)), [["agent", "codex"]]), statsUrl(range(180))]);
    expect($("#agents-btn").textContent?.trim()).toBe("All agents");
    expect($("#chips").hidden).toBe(true);
  });

  test("a member who never used the filtered agent: the filtered empty state, Clear filters and the machines; the filter is kept", async () => {
    await boot(json(statsFixture()));
    open("agents");
    replies.push(json(statsFixture()));
    tick(rowBoxes("agents")[1]); // Codex
    await flush();
    $(".tile").click(); // closes the popover

    replies.push(json(claudeOnlyMember(["codex"])));
    await goTo("#/member/1");
    // Sent as it is, answered once, never re-asked without the filter.
    expect(calls.at(-1)?.url).toBe(withFilters(memberUrl(range(90), 1), [["agent", "codex"]]));
    expect(calls).toHaveLength(3);
    expect($("#stats .empty p").textContent).toBe("Nothing matches these filters in this period");
    expect($("#empty-clear").textContent).toBe("Clear filters");
    expect(doc.querySelectorAll("#machines li")).toHaveLength(3);
    expect(chipTexts()).toEqual(["Codex"]);
    expect($("#agents-btn").textContent?.trim()).toBe("1 agent");

    // The popover lists the member's agents plus the selection they do not have, ticked, at zero.
    open("agents");
    expect([...doc.querySelectorAll("#agents-pop label.pop-row")].map((r) => [r.querySelector(".pop-name")?.textContent, r.querySelector(".pop-num")?.textContent, (r.querySelector("input") as HTMLInputElement).checked])).toEqual([
      ["Claude Code", "55,000", false],
      ["Codex", "0", true],
    ]);
    $(".tile").click();

    replies.push(json(statsFixture()));
    $("a.back").click();
    await flush();
    expect(calls.at(-1)?.url).toBe(withFilters(statsUrl(range(90)), [["agent", "codex"]]));
    expect(chipTexts()).toEqual(["Codex"]);
    expect($(".tile .k").textContent).toBe("Total tokens · filtered");
  });

  test("Clear filters in the member's empty state asks for the member without filters", async () => {
    await boot(json(statsFixture()));
    open("agents");
    replies.push(json(statsFixture()));
    tick(rowBoxes("agents")[1]);
    await flush();
    replies.push(json(claudeOnlyMember(["codex"])));
    await goTo("#/member/1");
    replies.push(json(claudeOnlyMember([])));
    $("#empty-clear").click();
    await flush();
    expect(calls.at(-1)?.url).toBe(memberUrl(range(90), 1));
    expect(doc.querySelector("#stats .empty")).toBeNull();
    expect($("#chips").hidden).toBe(true);
    expect($(".tile .v").textContent).toBe("55,000");
  });

  test("with Claude Code and Codex selected, a Claude-only member shows Claude data and both chips; both stay selected", async () => {
    await boot(json(statsFixture()));
    open("agents");
    replies.push(json(statsFixture()), json(statsFixture()));
    tick(rowBoxes("agents")[0]);
    await flush();
    tick(rowBoxes("agents")[1]);
    await flush();
    $(".tile").click();

    replies.push(json(claudeOnlyMember(["claude", "codex"])));
    await goTo("#/member/1");
    expect(calls.at(-1)?.url).toBe(withFilters(memberUrl(range(90), 1), [["agent", "claude"], ["agent", "codex"]]));
    expect($(".tile .v").textContent).toBe("55,000");
    expect([...doc.querySelectorAll(".legend .legend-name")].map((n) => n.textContent)).toEqual(["Claude Code"]);
    expect(chipTexts()).toEqual(["Claude Code", "Codex"]);
    expect($("#agents-btn").textContent?.trim()).toBe("2 agents");

    replies.push(json(statsFixture()));
    $("a.back").click();
    await flush();
    expect(calls.at(-1)?.url).toBe(withFilters(statsUrl(range(90)), [["agent", "claude"], ["agent", "codex"]]));
    expect(chipTexts()).toEqual(["Claude Code", "Codex"]);
  });

  test("when the load after a filter change fails, the bar and chips go back to what the data on screen shows", async () => {
    await boot(json(statsFixture()));
    open("agents");
    replies.push(new TypeError("offline"));
    tick(rowBoxes("agents")[1]);
    await flush();
    expect($("#status").hidden).toBe(false);
    expect($("#status-text").textContent).toBe("Could not reach the server.");
    expect($("#agents-btn").textContent?.trim()).toBe("All agents");
    expect($("#chips").hidden).toBe(true);
    expect(rowBoxes("agents").map((b) => b.checked)).toEqual([false, false, false]);
    expect($(".tile .k").textContent).toBe("Total tokens");

    // An error answer behaves the same, and Retry asks for what is on screen.
    replies.push(json({ error: "invalid query" }, 400));
    tick(rowBoxes("agents")[0]);
    await flush();
    expect($("#status-text").textContent).toBe("Could not load the statistics: invalid query");
    expect($("#chips").hidden).toBe(true);
    replies.push(json(statsFixture()));
    $("#retry").click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(90)));
    expect($("#status").hidden).toBe(true);
  });

  test("Escape closes the popover and gives focus back to its button; so does a click outside", async () => {
    await boot(json(statsFixture()));
    $("#models-btn").focus();
    open("models");
    expect(doc.activeElement?.id).toBe("models-btn");
    const search = $<HTMLInputElement>("#model-search");
    search.focus();
    key("Escape", search);
    expect(doc.querySelector(".popover")).toBeNull();
    expect($("#models-btn").getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement?.id).toBe("models-btn");

    open("agents");
    expect(doc.querySelector("#agents-pop")).not.toBeNull();
    $(".tile").click();
    expect(doc.querySelector(".popover")).toBeNull();

    // The button itself opens and closes.
    open("agents");
    open("agents");
    expect(doc.querySelector(".popover")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("keyboard: focus stays on the checkbox after ticking, and the search keeps its text across a reload", async () => {
    await boot(json(statsFixture()));
    open("models");
    const search = $<HTMLInputElement>("#model-search");
    search.focus();
    search.value = "OPUS";
    search.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    expect(rowBoxes("models")).toHaveLength(1);
    expect(calls).toHaveLength(1); // searching never asks the server
    expect(calls.every((c) => !c.url.includes("OPUS") && !c.url.includes("opus"))).toBe(true);

    const box = rowBoxes("models")[0] as HTMLInputElement;
    box.focus();
    replies.push(json(statsFixture()));
    tick(box);
    await flush();
    expect(calls.at(-1)?.url).toBe(withFilters(statsUrl(range(90)), [["model", "claude:claude-opus-4-1"]]));
    const focused = doc.activeElement as HTMLInputElement;
    expect(focused.type).toBe("checkbox");
    expect(focused.checked).toBe(true);
    expect($<HTMLInputElement>("#model-search").value).toBe("OPUS");
    expect(rowBoxes("models")).toHaveLength(1);
  });

  test("past 20 agents the page stops adding, says so and sends nothing", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `agent${String(i).padStart(2, "0")}`);
    const many = { ...statsFixture(), available: { agents: ids, models: ids.map((a) => ({ agent: a, model: "m", tokens: 1 })) } };
    await boot(json(many));
    open("agents");
    for (let i = 0; i < 20; i++) {
      replies.push(json(many));
      tick(rowBoxes("agents")[i]);
      await flush();
    }
    expect(new URLSearchParams(calls.at(-1)?.url.split("?")[1]).getAll("agent")).toHaveLength(20);
    const before = calls.length;
    tick(rowBoxes("agents")[20]);
    await flush();
    expect(calls).toHaveLength(before);
    expect($("#agents-pop .pop-note").textContent).toBe("You can select up to 20 agents.");
    expect(rowBoxes("agents")[20]?.checked).toBe(false);
  });

  test("a slow answer for an earlier filter never replaces a later one", async () => {
    await boot(json(statsFixture()));
    open("agents");
    let release: (r: Response) => void = () => {};
    replies.push(() => new Promise<Response>((r) => (release = r)));
    tick(rowBoxes("agents")[0]); // Claude Code: slow
    const both = { ...statsFixture(), totals: { tokens: 5_000, costUsd: 1.5, activeMembers: 2, memberCount: 3 } };
    replies.push(json(both));
    tick(rowBoxes("agents")[1]); // and Codex: fast
    await flush();
    expect(calls.slice(-2).map((c) => c.url)).toEqual([
      withFilters(statsUrl(range(90)), [["agent", "claude"]]),
      withFilters(statsUrl(range(90)), [["agent", "claude"], ["agent", "codex"]]),
    ]);
    expect((calls.at(-2)?.init.signal as AbortSignal).aborted).toBe(true);
    release(json(statsFixture()));
    await flush();
    expect($(".tile .v").textContent).toBe("5,000");
    expect($("#stats").classList.contains("loading")).toBe(false);
  });

  test("the member page shows the share of the team once the team total for the range is known", async () => {
    await boot(json(statsFixture()));
    replies.push(json(memberStatsFixture()));
    $('#members a[href="#/member/1"]').click();
    await flush();
    expect($(".tile .s").textContent).toBe("100% of the team's tokens");
    expect($(".member-head .avatar").textContent).toBe("AA");
    expect($("#page-head nav a.back").getAttribute("href")).toBe("#/");

    replies.push(json(statsFixture()));
    $("a.back").click();
    await flush();
    expect($("#page-head").childElementCount).toBe(0);
  });

  test("the filter bar is hidden while signing in", async () => {
    await boot(unauthorized());
    expect($("#filterbar").hidden).toBe(true);
  });
});
