import { afterEach, describe, expect, test } from "vitest";
import { json, nobody, type Page } from "../site/page.fixture.js";
import { HIDDEN_CODE } from "./code-card.js";
import { membersReply } from "./members-card.fixture.js";
import { team as someMembers } from "./members.fixture.js";
import { bootTeam, dialogButton, expectNowhereIn, openDialogOf, T, teamInfo } from "./page.fixture.js";

/** Removing from the team page: what the page does around the dialog (the list, the ticks, the status line, the code card). */

let page: Page;
afterEach(async () => page?.close());

const OLD_CODE = "0a1b2c3d4e5f60718293a4b5";
const NEW_CODE = "7f3a09c1d2e84b56a0f1c21e";
const removedReply = (members: number, machines: number, code?: string) => json(code === undefined ? { removed: { members, machines } } : { removed: { members, machines }, code });
const afterRemoval = () => membersReply(someMembers(3, 1).slice(2));

const urls = () => page.calls.map((c) => `${c.init.method ?? "GET"} ${c.url}`);
const ticks = () => [...page.doc.querySelectorAll<HTMLInputElement>("tbody input[data-tick]")];
const status = () => page.$("#removal-status");
const dialogText = () => openDialogOf(page)?.textContent ?? "";
const box = () => openDialogOf(page)?.querySelector("input[type=checkbox]") as HTMLInputElement;

async function removeTwoTicked(reply: Response) {
  page = await bootTeam(teamInfo("admin"), reply, afterRemoval());
  ticks()[0]?.click();
  ticks()[1]?.click();
  page.press("#members-remove-selected");
  expect(openDialogOf(page)?.querySelector("h2")?.textContent).toBe("Remove 2 members?");
}

describe("after a done removal", () => {
  test("the list is asked for again, no row is ticked, the status line says what went, and focus is on the card's heading", async () => {
    await removeTwoTicked(removedReply(2, 2));
    box().click();
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(urls().slice(-2)).toEqual([`POST /api/teams/${T}/removals`, `GET /api/teams/${T}/members`]);
    expect(openDialogOf(page)).toBeNull();
    expect(ticks()).toHaveLength(1);
    expect(ticks().some((b) => b.checked)).toBe(false);
    expect(page.$("#members-bar").hidden).toBe(true);
    expect(status().getAttribute("role")).toBe("status");
    expect(status().textContent).toBe("Removed 2 members.");
    expect(status().closest("[hidden]")).toBeNull();
    expect(page.doc.activeElement).toBe(page.$("#members-title"));
  });

  test("a row's Remove while other rows are ticked: after it is done, no row that is left is ticked", async () => {
    page = await bootTeam(teamInfo("admin"), removedReply(1, 1), membersReply(someMembers(3, 1).slice(1)));
    ticks()[1]?.click();
    ticks()[2]?.click();
    page.press(`tbody button[data-action=remove]`);
    expect(openDialogOf(page)?.querySelector("h2")?.textContent).toBe("Remove Person 0001?");
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(ticks()).toHaveLength(2);
    expect(ticks().some((b) => b.checked)).toBe(false);
  });

  test("the status line is one node, said anew for a second removal, and in Russian after the switch", async () => {
    page = await bootTeam(teamInfo("admin"), removedReply(1, 1), afterRemoval(), removedReply(1, 1), afterRemoval());
    const line = status();
    expect(line.textContent).toBe("");
    for (let i = 0; i < 2; i++) {
      page.press(`tbody button[data-action=remove]`);
      box().click();
      dialogButton(page, "confirm").click();
      const before = line.firstChild;
      await page.flush();
      expect(line.firstChild).not.toBe(before);
    }
    expect(status()).toBe(line);
    expect(line.textContent).toBe("Removed 1 member.");
    page.press("#lang button[data-lang=ru]");
    expect(line.textContent).toBe("Удалили 1 участника.");
  });

  test("after one with a code, the code card shows the dots and holds no code, and Show then asks the server and shows the new one", async () => {
    page = await bootTeam(teamInfo("owner"), json({ code: OLD_CODE }), removedReply(1, 1, NEW_CODE), afterRemoval(), json({ code: NEW_CODE }));
    page.press("#code-show");
    await page.flush();
    expect(page.$("#code-value").textContent).toBe(OLD_CODE);
    page.press(`tbody button[data-action=remove]`);
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(dialogText()).toContain(NEW_CODE);
    expect(page.$("#code-value [aria-hidden=true]").textContent).toBe(HIDDEN_CODE);
    expect(page.$("#code-value").textContent).not.toContain(OLD_CODE);
    expect(urls().slice(-2)).toEqual([`POST /api/teams/${T}/removals`, `GET /api/teams/${T}/members`]);
    dialogButton(page, "cancel").click();
    await page.flush();
    expectNowhereIn(page, NEW_CODE);
    expectNowhereIn(page, OLD_CODE);
    page.press("#code-show");
    await page.flush();
    expect(urls().at(-1)).toBe(`GET /api/teams/${T}/code`);
    expect(page.$("#code-value").textContent).toBe(NEW_CODE);
  });
});

describe("a removal the page cannot finish", () => {
  test("a 403: Close has the page read the session and the team again", async () => {
    await removeTwoTicked(json({ error: "your role does not allow this" }, 403));
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(dialogText()).toContain("Your role no longer allows this.");
    const before = page.calls.length;
    dialogButton(page, "cancel").click();
    await page.flush();
    expect(urls().slice(before, before + 2)).toEqual(["GET /api/me", `GET /api/teams/${T}`]);
  });

  test("a 401 closes the dialog and shows the sign-in panel, with no card left", async () => {
    page = await bootTeam(teamInfo("admin"), nobody());
    page.press(`tbody button[data-action=remove]`);
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(openDialogOf(page)).toBeNull();
    expect(page.shownViews()).toEqual(["signedOut"]);
    expect(page.$("#cards").childElementCount).toBe(0);
  });
});
