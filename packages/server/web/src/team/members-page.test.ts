import { afterEach, expect, test } from "vitest";
import { json, nobody, user, type Page } from "../site/page.fixture.js";
import { membersReply } from "./members-card.fixture.js";
import { member, machine, team } from "./members.fixture.js";
import { bootAt, bootTeam, LOGIN, T, teamInfo, teamReply, visible } from "./page.fixture.js";
import { listReplies } from "./roles.fixture.js";

let page: Page;
afterEach(async () => page?.close());

const urls = () => page.calls.map((c) => c.url);

test("an owner and an admin both get the members card, asked after the roles; a viewer gets no list at all", async () => {
  page = await bootTeam(teamInfo("owner"));
  expect(urls().at(-1)).toBe(`/api/teams/${T}/members`);
  expect(visible(page, "#members-card")).toBe(true);
  await page.close();
  page = await bootTeam(teamInfo("admin"));
  expect(visible(page, "#members-card")).toBe(true);
  await page.close();
  page = await bootTeam(teamInfo("viewer"));
  expect(urls().some((u) => u.endsWith("/members"))).toBe(false);
  expect(page.doc.querySelector("#members-card")).toBeNull();
});

test("the line under the team's name is the card's summary, in the page's language, and follows a language switch", async () => {
  page = await bootTeam(teamInfo("admin"));
  const heading = page.$("#team-title").closest(".team-head") as HTMLElement;
  const summary = page.$("#team-summary");
  expect(heading.nextElementSibling).toBe(summary);
  expect(summary.textContent).toBe("3 members, 1 not syncing");
  page.$("#lang button[data-lang='ru']").click();
  expect(summary.textContent).toBe("3 участника, 1 не отправляет данные");
  expect(page.$("#members-title").textContent).toBe("Участники 3");
});

test("a 401 of the members list is the sign-in panel and takes the cards away", async () => {
  page = await bootAt(`?team=${T}`, user([teamInfo("admin")], LOGIN), teamReply(teamInfo("admin")), ...listReplies("admin"), nobody());
  expect(page.shownViews()).toEqual(["signedOut"]);
  expect(page.$("#cards").childElementCount).toBe(0);
});

test("a role lost while the list is on its way reads the session again, and the page tells it", async () => {
  page = await bootAt(`?team=${T}`, user([teamInfo("admin")], LOGIN), teamReply(teamInfo("admin")), ...listReplies("admin"), json({ error: "forbidden" }, 403), user([]), json({ error: "not found" }, 404));
  expect(urls().slice(-2)).toEqual(["/api/me", `/api/teams/${T}`]);
  expect(page.shownViews()).toEqual(["notFound"]);
});

test("2,000 members: the page draws 25 rows of the table, and the line under the name counts them all", async () => {
  page = await bootAt(`?team=${T}`, user([teamInfo("owner")], LOGIN), teamReply(teamInfo("owner")), ...listReplies("owner"), membersReply([...team(1990, 14), ...Array.from({ length: 10 }, (_, i) => member(5000 + i, [machine("2026-11-27")]))]));
  expect(page.doc.querySelectorAll("#members-card tbody tr[data-member-id]")).toHaveLength(25);
  expect(page.$("#team-summary").textContent).toBe("2,000 members, 14 not syncing");
});
