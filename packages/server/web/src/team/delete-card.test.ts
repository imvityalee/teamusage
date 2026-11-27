import { afterEach, describe, expect, test } from "vitest";
import { NAME_DOES_NOT_MATCH as SERVER_NAME_DOES_NOT_MATCH } from "../../../src/routes-team-settings.js";
import { json, nobody, type Page } from "../site/page.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { NAME_DOES_NOT_MATCH, namesMatch } from "./delete-card.js";
import { bootTeam, dialogButton, openDialogOf, pressEscape, T, teamInfo, typeInto } from "./page.fixture.js";

let page: Page;
afterEach(async () => page?.close());

const STOPPED =
  "The deletion stopped before it finished. Part of the usage history is already deleted and the team still exists. Run it again to finish.";

/** Opens the owner's page of the team `name` and its "Delete team" dialog. */
async function openDelete(name: string, ...replies: Parameters<typeof bootTeam>[1][]) {
  page = await bootTeam(teamInfo("owner", { name }), ...replies);
  page.press("#delete-open");
  return openDialogOf(page)?.querySelector("input") as HTMLInputElement;
}

const errorText = () => openDialogOf(page)?.querySelector(".dialog-error")?.textContent;

test("the page's text of a name that does not match is the server's", () => {
  expect(NAME_DOES_NOT_MATCH).toBe(SERVER_NAME_DOES_NOT_MATCH);
});

test.each([
  ["Acme", "Acme", true],
  ["  Acme ", "Acme", true],
  ["acme", "Acme", false],
  ["Café", "Café", true],
  ["Café", "Café", true],
  ["", "Acme", false],
  ["Acme Engineering", "Acme", false],
])("typing %j for the team %j enables Delete: %s", async (typed, name, enabled) => {
  expect(namesMatch(typed, name)).toBe(enabled);
  const input = await openDelete(name);
  expect(dialogButton(page, "confirm").disabled).toBe(true);
  typeInto(page, input, typed);
  expect(dialogButton(page, "confirm").disabled).toBe(!enabled);
});

describe("deleting", () => {
  test("the dialog names the team and says what goes; Enter with another name sends nothing", async () => {
    const input = await openDelete("Acme");
    expect(openDialogOf(page)?.querySelector("h2")?.textContent).toBe("Delete Acme?");
    expect(openDialogOf(page)?.textContent).toContain("Type the team's name to confirm.");
    expect(["autocapitalize", "autocorrect", "spellcheck"].map((a) => input.getAttribute(a))).toEqual(["none", "off", "false"]);
    typeInto(page, input, "Acm");
    page.fire("dialog[open] form", "submit");
    await page.flush();
    expect(page.calls).toHaveLength(2);
  });

  test("a worst-case team name is drawn whole in the dialog's heading, and typing it enables Delete", async () => {
    const input = await openDelete(worstCase.teamName);
    expect(openDialogOf(page)?.querySelector("h2")?.textContent).toBe(`Delete ${worstCase.teamName}?`);
    typeInto(page, input, worstCase.teamName);
    expect(dialogButton(page, "confirm").disabled).toBe(false);
  });

  test("while the request is out the dialog is busy; a 204 goes to the list of teams", async () => {
    const input = await openDelete("Acme", new Response(null, { status: 204 }));
    typeInto(page, input, " Acme ");
    dialogButton(page, "confirm").click();
    dialogButton(page, "confirm").click();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(dialogButton(page, "confirm").textContent).toBe("Deleting…");
    expect(dialogButton(page, "confirm").disabled).toBe(true);
    expect(dialogButton(page, "cancel").disabled).toBe(true);
    expect(pressEscape(page).defaultPrevented).toBe(true);
    expect(openDialogOf(page)).not.toBeNull();
    const call = page.calls[2];
    expect([call?.url, call?.init.method, JSON.parse(String(call?.init.body))]).toEqual([`/api/teams/${T}/delete`, "POST", { name: "Acme" }]);
    await page.flush();
    expect(page.replace).toHaveBeenCalledWith("/teams#all");
  });

  test("a name that does not match on the server says the team may have been renamed", async () => {
    const input = await openDelete("Acme", json({ error: NAME_DOES_NOT_MATCH }, 400));
    typeInto(page, input, "Acme");
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(errorText()).toBe("The name does not match. The team may have been renamed: reload the page.");
    expect(openDialogOf(page)?.getAttribute("aria-busy")).toBe("false");
    expect(page.doc.activeElement).toBe(dialogButton(page, "confirm"));
  });

  test("a deletion that fails after it was sent says it stopped midway and offers to run it again", async () => {
    const input = await openDelete("Acme", json({ error: "internal" }, 500), new Response(null, { status: 204 }));
    typeInto(page, input, "Acme");
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(errorText()).toBe(STOPPED);
    expect(dialogButton(page, "confirm").textContent).toBe("Run it again");
    expect(dialogButton(page, "confirm").disabled).toBe(false);
    expect(openDialogOf(page)?.getAttribute("aria-busy")).toBe("false");
    expect(page.doc.activeElement).toBe(dialogButton(page, "confirm"));
    dialogButton(page, "confirm").click();
    await page.flush();
    const runs = page.calls.filter((c) => c.url.endsWith("/delete"));
    expect(runs).toHaveLength(2);
    expect(runs[1]?.init.body).toBe(runs[0]?.init.body);
    expect(page.replace).toHaveBeenCalledWith("/teams#all");
  });

  test("a 404 to the run again means nothing is left to delete: the list of teams", async () => {
    const input = await openDelete("Acme", json({ error: "internal" }, 500), json({ error: "team not found" }, 404));
    typeInto(page, input, "Acme");
    dialogButton(page, "confirm").click();
    await page.flush();
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(page.replace).toHaveBeenCalledWith("/teams#all");
  });

  test("the field edited while the request is out decides the button afterwards", async () => {
    let answer: (res: Response) => void = () => {};
    const input = await openDelete("Acme", new Promise<Response>((resolve) => (answer = resolve)));
    typeInto(page, input, "Acme");
    dialogButton(page, "confirm").click();
    typeInto(page, input, "Acm");
    answer(json({ error: "internal" }, 500));
    await page.flush();
    expect(errorText()).toBe(STOPPED);
    expect(dialogButton(page, "confirm").disabled).toBe(true);
  });

  test.each([
    ["a 403", json({ error: "your role does not allow this" }, 403)],
    ["a network error", new TypeError("Failed to fetch")],
  ])("%s after it was sent: the same", async (_name, reply) => {
    const input = await openDelete("Acme", reply);
    typeInto(page, input, "Acme");
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(errorText()).toBe(STOPPED);
    expect(dialogButton(page, "confirm").textContent).toBe("Run it again");
  });

  test("another refusal is said in the page's sentence, and the dialog stays", async () => {
    const input = await openDelete("Acme", json({ error: "invalid name" }, 400));
    typeInto(page, input, "Acme");
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(errorText()).toBe("The server refused this request: invalid name");
    expect(dialogButton(page, "confirm").textContent).toBe("Delete team");
  });

  test("a 401 closes the dialog and shows the sign-in panel", async () => {
    const input = await openDelete("Acme", nobody());
    typeInto(page, input, "Acme");
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(openDialogOf(page)).toBeNull();
    expect(page.shownViews()).toEqual(["signedOut"]);
    expect(page.doc.activeElement).toBe(page.$("#sign-in"));
  });

  test("Cancel closes it with nothing sent, and focus goes back to the card's button", async () => {
    await openDelete("Acme");
    dialogButton(page, "cancel").click();
    expect(openDialogOf(page)).toBeNull();
    expect(page.calls).toHaveLength(2);
    expect(page.doc.activeElement).toBe(page.$("#delete-open"));
  });
});
