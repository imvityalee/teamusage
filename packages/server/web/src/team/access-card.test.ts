import { afterEach, expect, test } from "vitest";
import { json, nobody, type Page } from "../site/page.fixture.js";
import { bootTeam, dialogButton, openDialogOf, T, teamInfo, teamReply, visible } from "./page.fixture.js";

let page: Page;
afterEach(async () => page?.close());

const option = (value: string) => openDialogOf(page)?.querySelector<HTMLInputElement>(`input[value="${value}"]`) as HTMLInputElement;
const choose = (value: string) => {
  option(value).checked = true;
  option(value).dispatchEvent(new page.win.Event("change", { bubbles: true }) as unknown as Event);
};

test.each([
  ["members", "Every member", "Every member can open the dashboard from their coding agent. Only the owner can change this."],
  [
    "admins",
    "Admins only",
    "Only the owner, the admins and the viewers can open the dashboard. Members still see their own numbers in their agent. Only the owner can change this.",
  ],
] as const)("the card shows the current choice: %s", async (access, badge, text) => {
  page = await bootTeam(teamInfo("admin", { dashboardAccess: access }));
  expect(page.$("#access-card h2").textContent).toBe("Dashboard access");
  expect(page.$("#access-value").textContent).toBe(badge);
  expect(page.$("#access-text").textContent).toBe(text);
  expect(visible(page, "#access-change")).toBe(false);
});

test("Change… shows the two options with the current one chosen, and the sign-out line under Admins only", async () => {
  page = await bootTeam(teamInfo("owner", { dashboardAccess: "admins" }));
  page.press("#access-change");
  expect(openDialogOf(page)?.querySelector("h2")?.textContent).toBe("Who can open the dashboard?");
  expect(option("admins").checked).toBe(true);
  expect(option("members").checked).toBe(false);
  expect(option("members").closest("label")?.textContent).toContain("Members open the dashboard from their coding agent.");
  expect(option("admins").closest("label")?.textContent).toContain("Members who are signed in to the dashboard are signed out.");
  expect(page.doc.activeElement).toBe(option("admins"));
});

test("choosing the same access sends nothing and closes the dialog", async () => {
  page = await bootTeam(teamInfo("owner"));
  page.press("#access-change");
  choose("members");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(openDialogOf(page)).toBeNull();
  expect(page.calls).toHaveLength(2);
  expect(page.doc.activeElement).toBe(page.$("#access-change"));
});

test("another choice is sent; the card shows the server's answer", async () => {
  page = await bootTeam(teamInfo("owner"), teamReply(teamInfo("owner", { dashboardAccess: "admins" })));
  page.press("#access-change");
  choose("admins");
  dialogButton(page, "confirm").click();
  dialogButton(page, "confirm").click();
  expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  const call = page.calls[2];
  expect([call?.url, call?.init.method, JSON.parse(String(call?.init.body))]).toEqual([`/api/teams/${T}`, "PATCH", { dashboardAccess: "admins" }]);
  await page.flush();
  expect(openDialogOf(page)).toBeNull();
  expect(page.$("#access-value").textContent).toBe("Admins only");
});

test("a refusal is said in the dialog, which stays", async () => {
  page = await bootTeam(teamInfo("owner"), json({ error: "your role does not allow this" }, 403));
  page.press("#access-change");
  choose("admins");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(openDialogOf(page)?.querySelector(".dialog-error")?.textContent).toBe("The server refused this request: your role does not allow this");
  expect(page.doc.activeElement).toBe(dialogButton(page, "confirm"));
});

test("an answer that is not a team is said as unreadable", async () => {
  page = await bootTeam(teamInfo("owner"), json({ team: { id: T } }));
  page.press("#access-change");
  choose("admins");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(openDialogOf(page)?.querySelector(".dialog-error")?.textContent).toBe("The server's answer could not be read.");
});

test("a 401 closes the dialog and shows the sign-in panel", async () => {
  page = await bootTeam(teamInfo("owner"), nobody());
  page.press("#access-change");
  choose("admins");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(openDialogOf(page)).toBeNull();
  expect(page.shownViews()).toEqual(["signedOut"]);
});
