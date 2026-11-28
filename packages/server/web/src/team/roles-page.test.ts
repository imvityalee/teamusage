import { afterEach, expect, test } from "vitest";
import { json, nobody, user, type Page } from "../site/page.fixture.js";
import { bootTeam, dialogButton, expectNowhereIn, openDialogOf, T, teamInfo, teamReply, visible } from "./page.fixture.js";
import { ADMIN, ME, MY_ADMIN, rolesReply, TOKEN } from "./roles.fixture.js";

let page: Page;
afterEach(async () => page?.close());

const urls = () => page.calls.map((c) => c.url);
const rowActions = (id: number) => [...page.doc.querySelectorAll(`[data-github-id="${id}"] button`)].map((b) => (b as HTMLElement).dataset.action);

test("the card sits after the dashboard access and before the deletion", async () => {
  page = await bootTeam(teamInfo("owner"));
  const order = [...page.$("#cards").children].map((el) => el.id || el.className);
  expect(order.slice(3)).toEqual(["access-card", "roles-card", "delete-card"]);
});

test("a handover reads the session and the team again, and the former owner then offers Leave team and no Invite…", async () => {
  page = await bootTeam(
    teamInfo("owner"),
    new Response(null, { status: 204 }),
    user([teamInfo("admin")]),
    teamReply(teamInfo("admin")),
    rolesReply([{ ...ADMIN, role: "owner" }, MY_ADMIN]),
  );
  expect(visible(page, "#roles-invite")).toBe(true);
  expect(rowActions(ADMIN.githubId)).toEqual(["remove", "makeOwner"]);
  page.$<HTMLButtonElement>(`[data-github-id="${ADMIN.githubId}"] [data-action=makeOwner]`).click();
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(urls().slice(4)).toEqual([`/api/teams/${T}/owner`, "/api/me", `/api/teams/${T}`, `/api/teams/${T}/roles`]);
  expect(openDialogOf(page)).toBeNull();
  expect(visible(page, "#roles-invite")).toBe(false);
  expect(rowActions(ME)).toEqual(["leave"]);
  expect(rowActions(ADMIN.githubId)).toEqual([]);
  expect(visible(page, "#delete-card")).toBe(false);
  expect(page.shownViews()).toEqual(["page"]);
  expect(page.doc.activeElement).toBe(page.$("#roles-title"));
});

test("the admin's page asks for no invites", async () => {
  page = await bootTeam(teamInfo("admin"));
  expect(urls()).toEqual(["/api/me", `/api/teams/${T}`, `/api/teams/${T}/roles`]);
  expect(visible(page, "#roles-invite")).toBe(false);
  expect(page.doc.querySelector("[data-invite-id]")).toBeNull();
});

test("a 401 from a dialog of this card takes the shown code and the card off the page", async () => {
  const CODE = "9f8e7d6c5b4a39281706f5e4";
  page = await bootTeam(teamInfo("owner"), json({ code: CODE }), nobody());
  page.press("#code-show");
  await page.flush();
  expect(page.$("#code-value").textContent).toBe(CODE);
  page.$<HTMLButtonElement>(`[data-github-id="${ADMIN.githubId}"] [data-action=remove]`).click();
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(page.shownViews()).toEqual(["signedOut"]);
  expect(page.doc.body.textContent).not.toContain(CODE);
  expect(page.doc.querySelector("#roles-card")).toBeNull();
});

test("the invite's link, shown in this page's dialog, leaves nothing behind once it is closed", async () => {
  page = await bootTeam(teamInfo("owner"), json({ invite: { id: "ab12cd34ef567890", role: "viewer", createdAt: "2026-11-27T09:00:00.000Z", expiresAt: "2026-12-04T09:00:00.000Z" }, token: TOKEN }, 201));
  page.press("#roles-invite");
  const viewer = page.$<HTMLInputElement>('dialog[open] input[value="viewer"]');
  viewer.checked = true;
  viewer.dispatchEvent(new page.win.Event("change", { bubbles: true }) as unknown as Event);
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(openDialogOf(page)?.querySelector(".code")?.textContent).toBe(`http://localhost:8787/invite#${TOKEN}`);
  dialogButton(page, "cancel").click();
  await page.flush();
  expectNowhereIn(page, TOKEN);
});
