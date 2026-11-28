import { afterEach, expect, test } from "vitest";
import { json, type Page } from "../site/page.fixture.js";
import { bootTeam, openDialogOf, teamInfo } from "./page.fixture.js";

/** Signing out of the team page: by the time the browser is sent home, nothing the page showed is left in it. */

const CODE = "9f8e7d6c5b4a39281706f5e4";
let page: Page;
afterEach(async () => page?.close());

test("when the browser is sent home, the cards, the shown code, the members and any open dialog are already gone", async () => {
  page = await bootTeam(teamInfo("owner"), json({ code: CODE }), new Response(null, { status: 204 }));
  page.press("#code-show");
  await page.flush();
  page.press("#rename");
  expect(page.$("#code-value").textContent).toBe(CODE);
  expect(page.doc.body.textContent).toContain("Person 0001");
  expect(openDialogOf(page)).not.toBeNull();

  let atNavigation: { html: string; cards: number; dialogs: number } | null = null;
  page.assign.mockImplementation(() => {
    atNavigation = { html: page.doc.documentElement.outerHTML, cards: page.$("#cards").childElementCount, dialogs: page.doc.querySelectorAll("dialog[open]").length };
  });
  page.press("#sign-out");
  await page.flush();

  expect(page.assign).toHaveBeenCalledExactlyOnceWith("/");
  expect(atNavigation).toMatchObject({ cards: 0, dialogs: 0 });
  const html = (atNavigation as { html: string } | null)?.html ?? "";
  expect(html).not.toContain(CODE);
  expect(html).not.toContain("Person 0001");
});
