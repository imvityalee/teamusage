import { afterEach, expect, test } from "vitest";
import { user, type Page } from "../site/page.fixture.js";
import { boot } from "./page.fixture.js";

/** Signing out of `/teams`: by the time the browser is sent home, the list of teams and the login are off the page. */

const TEAMS = [
  { id: "1111111111111111", name: "Acme Engineering", role: "owner" as const },
  { id: "2222222222222222", name: "Zeta Research", role: "viewer" as const },
];
let page: Page;
afterEach(async () => page?.close());

test("when the browser is sent home, no team of the list and no login is left in the document", async () => {
  page = await boot("", user(TEAMS, "acme-admin"), new Response(null, { status: 204 }));
  expect(page.doc.body.textContent).toContain("Zeta Research");
  let atNavigation = "";
  page.assign.mockImplementation(() => (atNavigation = page.doc.documentElement.outerHTML));
  page.press("#sign-out");
  await page.flush();
  expect(page.assign).toHaveBeenCalledExactlyOnceWith("/");
  for (const shown of ["Acme Engineering", "Zeta Research", "acme-admin"]) expect(atNavigation).not.toContain(shown);
});
