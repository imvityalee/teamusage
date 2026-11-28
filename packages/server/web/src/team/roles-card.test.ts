import { afterEach, expect, test } from "vitest";
import { json, nobody } from "../site/page.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { T } from "./page.fixture.js";
import { ADMIN, invitesReply, ME, MY_ADMIN, MY_OWNER, OTHER_ADMIN, OWNER, PENDING, PENDING_VIEWER, rolesReply, VIEWER } from "./roles.fixture.js";
import { loginsIn, mountRoles, rowOf, type Mounted } from "./roles-card.fixture.js";
import type { RoleEntry } from "./api.js";

let m: Mounted;
afterEach(async () => m?.world.close());

const text = (el: Element) => el.textContent ?? "";

test("the list is the owner first, then admins, then viewers, each by login, with the pending invites under the people", async () => {
  m = await mountRoles("owner", [rolesReply([VIEWER, OTHER_ADMIN, MY_OWNER, ADMIN]), invitesReply([PENDING, PENDING_VIEWER])]);
  expect(loginsIn(m)).toEqual(["@acme-admin", "@aigerim-t", "@bakyt-s", "@nurlan-b", "Admin invite, not used yet", "Viewer invite, not used yet"]);
});

test("an owner's card asks for the roles and the invites; an admin's asks for the roles only and has no Invite…", async () => {
  m = await mountRoles("owner", [rolesReply([MY_OWNER]), invitesReply([])]);
  expect(m.world.calls.map((c) => c.url)).toEqual([`/api/teams/${T}/roles`, `/api/teams/${T}/invites`]);
  expect(m.$<HTMLButtonElement>("#roles-invite").hidden).toBe(false);
  await m.world.close();
  m = await mountRoles("admin", [rolesReply([OWNER, MY_ADMIN])]);
  expect(m.world.calls.map((c) => c.url)).toEqual([`/api/teams/${T}/roles`]);
  expect(m.$<HTMLButtonElement>("#roles-invite").hidden).toBe(true);
  expect(m.all("[data-invite-id]")).toEqual([]);
});

test("'You' is found by the GitHub id, never by the login: two rows with one login, one is the viewer's", async () => {
  const twin: RoleEntry = { githubId: ME + 1, login: MY_OWNER.login, role: "viewer", since: "2026-10-01T12:00:00.000Z" };
  m = await mountRoles("owner", [rolesReply([MY_OWNER, twin]), invitesReply([])]);
  expect(text(rowOf(m, ME))).toContain("You, in the team since Aug 30, 2026");
  expect(text(rowOf(m, twin.githubId))).not.toContain("You");
  expect(text(rowOf(m, twin.githubId))).toContain("Added on Oct 1, 2026");
  expect(m.all(".role-row").filter((row) => text(row).includes("You"))).toHaveLength(1);
});

test("each row says its role and the day, in the page's language and the given time zone", async () => {
  m = await mountRoles("owner", [rolesReply([MY_OWNER, ADMIN, VIEWER]), invitesReply([PENDING])]);
  expect(text(rowOf(m, ADMIN.githubId))).toContain("Admin");
  expect(text(rowOf(m, ADMIN.githubId))).toContain("Added on Sep 3, 2026");
  expect(text(rowOf(m, VIEWER.githubId))).toContain("Viewer");
  expect(text(m.$(`[data-invite-id="${PENDING.id}"]`))).toContain("Created Nov 27, 2026. The link works once and ends on Dec 4, 2026.");
  await m.world.close();
  m = await mountRoles("owner", [rolesReply([MY_OWNER, ADMIN]), invitesReply([PENDING])], { lang: "ru" });
  expect(text(rowOf(m, ADMIN.githubId))).toMatch(/Добавлен 3 сент\. 2026 г\..*Администратор/s);
  expect(text(m.$(`[data-invite-id="${PENDING.id}"]`))).toContain("действует до 4 дек. 2026 г.");
});

test("what each row offers: the owner removes an admin or a viewer and makes an admin the owner; an admin only leaves", async () => {
  m = await mountRoles("owner", [rolesReply([MY_OWNER, ADMIN, VIEWER]), invitesReply([])]);
  const actions = (id: number) => [...rowOf(m, id).querySelectorAll("button")].map((b) => b.dataset.action);
  expect([actions(ME), actions(ADMIN.githubId), actions(VIEWER.githubId)]).toEqual([[], ["remove", "makeOwner"], ["remove"]]);
  await m.world.close();
  m = await mountRoles("admin", [rolesReply([OWNER, MY_ADMIN, OTHER_ADMIN, VIEWER])]);
  expect(m.all(".role-row button").map((b) => [b.closest("li")?.getAttribute("data-github-id"), b.dataset.action])).toEqual([[String(ME), "leave"]]);
});

test("a button names the person and keeps its visible words in its name", async () => {
  m = await mountRoles("owner", [rolesReply([MY_OWNER, ADMIN, VIEWER]), invitesReply([PENDING])]);
  expect(rowOf(m, ADMIN.githubId).querySelector("[data-action=remove]")?.getAttribute("aria-label")).toBe("Remove admin @aigerim-t");
  expect(rowOf(m, VIEWER.githubId).querySelector("[data-action=remove]")?.getAttribute("aria-label")).toBe("Remove viewer @nurlan-b");
  expect(rowOf(m, ADMIN.githubId).querySelector("[data-action=makeOwner]")?.getAttribute("aria-label")).toBe("Make owner: @aigerim-t");
  expect(m.$(`[data-invite-id="${PENDING.id}"] button`).getAttribute("aria-label")).toBe("Cancel invite: admin, ends on Dec 4, 2026");
});

test.each([
  ["en", "Admins and viewers", 1],
  ["ru", "Администраторы и наблюдатели", 1],
] as const)("one admin reads '%s 1' (%s), the owner not counted", async (lang, label, n) => {
  m = await mountRoles("admin", [rolesReply([OWNER, MY_ADMIN])], { lang });
  expect(text(m.$("#roles-title"))).toBe(`${label} ${n}`);
});

test("a login of 39 characters and 50 rows draw whole, as text", async () => {
  const long = "a".repeat(38) + "z";
  const many = Array.from({ length: 49 }, (_, n): RoleEntry => ({ githubId: 100 + n, login: n === 0 ? long : `member-${n}`, role: "viewer", since: "2026-10-01T12:00:00.000Z" }));
  m = await mountRoles("owner", [rolesReply([MY_OWNER, ...many]), invitesReply([])]);
  expect(m.all(".role-row")).toHaveLength(50);
  expect(loginsIn(m)).toContain(`@${long}`);
  expect(long).toHaveLength(39);
  expect(text(m.$("#roles-title"))).toBe("Admins and viewers 49");
  const logins = new Set(loginsIn(m));
  expect(logins.size).toBe(50);
  expect(worstCase.login.length).toBeLessThanOrEqual(39);
});

test("a login that looks like markup is text", async () => {
  const odd = { ...VIEWER, login: "<img src=x>" };
  m = await mountRoles("owner", [rolesReply([MY_OWNER, odd]), invitesReply([])]);
  expect(m.$("#roles-list img")).toBeNull();
  expect(loginsIn(m)).toContain("@<img src=x>");
});

test("the card is drawn again in the other language, with the list as it was", async () => {
  m = await mountRoles("owner", [rolesReply([MY_OWNER, ADMIN]), invitesReply([PENDING])]);
  m.world.setLang("ru");
  m.card.paint();
  expect(text(m.$("#roles-title"))).toBe("Администраторы и наблюдатели 1");
  expect(m.$("#roles-invite").textContent).toBe("Пригласить…");
  expect(loginsIn(m)).toEqual(["@acme-admin", "@aigerim-t", "Приглашение администратора, ещё не использовано"]);
  expect(m.all(".role-row")).toHaveLength(3);
  expect(m.world.calls).toHaveLength(2);
});

test.each([
  ["the network", new TypeError("Failed to fetch"), "The server could not be reached."],
  ["a 502", json({ error: "bad gateway" }, 502), "The server could not be reached."],
  ["a refusal", json({ error: "<b>team is busy</b>" }, 409), "The server refused this request: <b>team is busy</b>"],
])("a list that does not come: %s is told in the card's alert, with Try again, and a second try reads the lists again", async (_name, reply, sentence) => {
  m = await mountRoles("admin", [reply, rolesReply([OWNER, MY_ADMIN])]);
  expect(text(m.$("#roles-error"))).toBe(`Could not load the admins and viewers. ${sentence}`);
  expect(m.$("#roles-error").getAttribute("role")).toBe("alert");
  expect(m.$("#roles-error b")).toBeNull();
  m.$("#roles-retry").click();
  await m.world.flush();
  expect(m.$("#roles-error").hidden).toBe(true);
  expect(m.all(".role-row")).toHaveLength(2);
});

test("a 2xx that is not a list is unreadable, not a blank card", async () => {
  m = await mountRoles("admin", [json({ roles: [{ login: 4 }] })]);
  expect(text(m.$("#roles-error"))).toBe("Could not load the admins and viewers. The server's answer could not be read.");
});

test("a 401 from either list is the page's: the sign-in panel, no alert of the card's own", async () => {
  m = await mountRoles("owner", [rolesReply([MY_OWNER]), nobody()]);
  expect(m.world.ctx.signedOut).toHaveBeenCalledTimes(1);
  expect(m.$("#roles-error").hidden).toBe(true);
});

test("the heading, not an alert, is the card's name; the alert is on its own node", async () => {
  m = await mountRoles("admin", [new TypeError("x")]);
  expect(m.$("#roles-title").closest("[role=alert]")).toBeNull();
  expect(m.$("#roles-card").getAttribute("aria-labelledby")).toBe("roles-title");
});
