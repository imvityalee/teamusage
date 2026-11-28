import { afterEach, describe, expect, test, vi } from "vitest";
import { json, nobody, user, type Page } from "../site/page.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { boot } from "./page.fixture.js";
import { strings } from "./strings.js";

const NEW_ID = "abcdef0123456789";
const CODE = "TEAM-ZQXJ-7K2M-RECOGNISABLE";
const created = () => json({ team: { id: NEW_ID, name: "Acme", role: "owner", dashboardAccess: "members" }, code: CODE }, 201);
const refused = (status: number, error: string) => json({ error }, status);

let page: Page;
afterEach(async () => page?.close());

const input = (sel: string) => page.$<HTMLInputElement>(sel);
const radio = (value: string) => input(`input[name="dashboard-access"][value="${value}"]`);
const posts = () => page.calls.filter((c) => c.url === "/api/teams");
const shown = (sel: string) => !page.$(sel).hidden;

function fill(name: string, access: "members" | "admins" | null): void {
  input("#team-name").value = name;
  if (access !== null) radio(access).checked = true;
}

async function openForm(...replies: Parameters<typeof boot>[1][]): Promise<void> {
  page = await boot("#new", user([]), ...replies);
  expect(page.shownViews()).toEqual(["create"]);
}

describe("the form at rest", () => {
  test("nothing is preselected, the name takes 60 characters, and no error shows before a press", async () => {
    await openForm();
    expect(radio("members").checked).toBe(false);
    expect(radio("admins").checked).toBe(false);
    expect(input("#team-name").value).toBe("");
    expect(input("#team-name").maxLength).toBe(60);
    for (const sel of ["#name-error", "#access-error", "#form-notice"]) expect(shown(sel)).toBe(false);
    expect(page.$("#create").textContent).toBe("Create team");
  });
});

describe("pressing Create team before the form is right", () => {
  test("with nothing chosen shows the choice's error beside it, sends no request and moves focus to the choice", async () => {
    await openForm();
    fill("Acme", null);
    page.press("#create");
    await page.flush();
    expect(shown("#access-error")).toBe(true);
    expect(page.$("#access-error").textContent).toBe(strings.en.accessError);
    expect(shown("#name-error")).toBe(false);
    expect(posts()).toHaveLength(0);
    expect(page.doc.activeElement).toBe(radio("members"));
    expect(page.$("fieldset").getAttribute("aria-describedby")).toContain("access-error");
  });

  test("with an empty name shows the name's error, marks the field invalid and focuses it", async () => {
    await openForm();
    fill("   ", "admins");
    page.press("#create");
    await page.flush();
    expect(page.$("#name-error").textContent).toBe("Use 1 to 60 characters, with no line breaks.");
    expect(input("#team-name").getAttribute("aria-invalid")).toBe("true");
    expect(page.doc.activeElement).toBe(input("#team-name"));
    expect(posts()).toHaveLength(0);
  });

  test("an error goes away when its field is corrected", async () => {
    await openForm();
    fill("", null);
    page.press("#create");
    expect(shown("#name-error")).toBe(true);
    page.fire("#team-name", "input");
    expect(shown("#name-error")).toBe(false);
    expect(input("#team-name").getAttribute("aria-invalid")).toBe("false");
    fill("Acme", null);
    page.press("#create");
    expect(shown("#access-error")).toBe(true);
    page.fire('input[value="members"]', "change");
    expect(shown("#access-error")).toBe(false);
  });
});

describe("a team is created", () => {
  test("the request carries the trimmed name and the choice, and the browser goes to the team page only", async () => {
    await openForm(created());
    fill(`  ${worstCase.teamName}  `, "admins");
    page.press("#create");
    await page.flush();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.init.method).toBe("POST");
    expect(JSON.parse(posts()[0]?.init.body as string)).toEqual({ name: worstCase.teamName, dashboardAccess: "admins" });
    expect(page.assign).toHaveBeenCalledExactlyOnceWith(`/team?team=${NEW_ID}`);
  });

  test("the new team's code is nowhere: not on the page, the title, storage, the address, the console or another request", async () => {
    await openForm(created());
    fill("Acme", "members");
    page.press("#create");
    await page.flush();
    expect(page.doc.documentElement.outerHTML).not.toContain(CODE);
    for (const el of page.doc.querySelectorAll("*")) {
      expect(el.textContent === CODE).toBe(false);
      for (const attr of Array.from(el.attributes)) expect(attr.value).not.toContain(CODE);
    }
    expect(page.doc.title).not.toContain(CODE);
    expect(page.win.localStorage.getItem("teamusage.lang") ?? "").not.toContain(CODE);
    expect(JSON.stringify({ ...page.win.localStorage })).not.toContain(CODE);
    expect(JSON.stringify({ ...page.win.sessionStorage })).not.toContain(CODE);
    expect(page.doc.cookie).toBe("");
    expect(page.win.location.href).not.toContain(CODE);
    expect(JSON.stringify(page.logged)).not.toContain(CODE);
    expect(JSON.stringify(page.assign.mock.calls)).not.toContain(CODE);
    expect(page.calls.map((c) => c.url)).toEqual(["/api/me", "/api/teams"]);
  });

  test("a double press, or Enter meanwhile, sends one request, and the button is disabled and says Creating… meanwhile", async () => {
    await openForm("pending");
    fill("Acme", "members");
    page.press("#create");
    page.press("#create");
    page.press("#create");
    expect(page.$("#create").getAttribute("disabled")).not.toBeNull();
    expect(page.$("#create").getAttribute("aria-busy")).toBe("true");
    expect(page.$("#create").textContent).toBe("Creating…");
    page.fire("#create-form", "submit"); // Enter in the field
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); // /api/me and one POST
    expect(posts()).toHaveLength(1);
  });
});

describe("a refusal", () => {
  async function submitWith(reply: Parameters<typeof boot>[1]): Promise<void> {
    await openForm(reply);
    fill("Acme", "members");
    page.press("#create");
    page.press("#create"); // a second press while the first is out
    // A browser drops focus from a button that becomes disabled.
    (page.doc.activeElement as HTMLElement | null)?.blur();
    await page.flush();
  }

  test.each([
    ["the owner's limit", refused(409, "you already own 5 teams"), "You own 5 teams, the most one account can."],
    ["paused sign-ups", refused(503, "sign-ups are paused"), "New teams are paused for now. Try again later."],
    ["another refusal", refused(403, "cross-site request refused"), "The team could not be created. The server answered: cross-site request refused"],
    ["a refusal without the server's text", new Response("<h1>Forbidden</h1>", { status: 403 }), strings.en.errorFailed],
    ["a server error", json({ error: "internal error" }, 500), strings.en.errorFailed],
    ["a network error", new TypeError("Failed to fetch"), strings.en.errorNetwork],
  ])("%s: its own sentence, the button back and focus on the button", async (_what, reply, text) => {
    await submitWith(reply);
    expect(page.$("#form-notice").textContent).toBe(text);
    expect(shown("#form-notice")).toBe(true);
    expect(page.$("#create").getAttribute("disabled")).toBeNull();
    expect(page.$("#create").textContent).toBe("Create team");
    expect(page.doc.activeElement).toBe(page.$("#create"));
    expect(posts()).toHaveLength(1);
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.$("#form-notice").childElementCount).toBe(0);
  });

  test("another refusal's text stays inside the page's own sentence, in Russian too", async () => {
    await submitWith(refused(403, "cross-site request refused"));
    page.press('#lang [data-lang="ru"]');
    expect(page.$("#form-notice").textContent).toBe("Не удалось создать команду. Ответ сервера: cross-site request refused");
  });

  test("invalid name puts the error on the name field and the focus there", async () => {
    await submitWith(refused(400, "invalid name"));
    expect(shown("#name-error")).toBe(true);
    expect(shown("#form-notice")).toBe(false);
    expect(page.doc.activeElement).toBe(input("#team-name"));
    expect(page.$("#create").getAttribute("disabled")).toBeNull();
  });

  test("a second try after a failure goes through", async () => {
    await openForm(refused(503, "sign-ups are paused"), created());
    fill("Acme", "members");
    page.press("#create");
    await page.flush();
    page.press("#create");
    await page.flush();
    expect(posts()).toHaveLength(2);
    expect(shown("#form-notice")).toBe(false);
    expect(page.assign).toHaveBeenCalledExactlyOnceWith(`/team?team=${NEW_ID}`);
  });

  test("the error text follows a language switch", async () => {
    await submitWith(refused(503, "sign-ups are paused"));
    page.press('#lang [data-lang="ru"]');
    expect(page.$("#form-notice").textContent).toBe(strings.ru.errorPaused);
    expect(page.$("#create").textContent).toBe(strings.ru.create);
  });
});

describe("a 401 while creating", () => {
  test("leads to the sign-in panel, with the form gone and nothing more asked", async () => {
    await openForm(nobody());
    fill("Acme", "members");
    page.press("#create");
    await page.flush();
    expect(page.shownViews()).toEqual(["signedOut"]);
    expect(page.$("#account").hidden).toBe(true);
    expect(page.calls.map((c) => c.url)).toEqual(["/api/me", "/api/teams"]);
    expect(page.assign).not.toHaveBeenCalled();
  });
});
