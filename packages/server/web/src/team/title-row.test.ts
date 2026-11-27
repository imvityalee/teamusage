import { afterEach, expect, test } from "vitest";
import { json, nobody, type Page } from "../site/page.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { bootTeam, dialogButton, openDialogOf, T, teamInfo, teamReply, typeInto } from "./page.fixture.js";

let page: Page;
afterEach(async () => page?.close());

const field = () => openDialogOf(page)?.querySelector("input") as HTMLInputElement;
const errorText = () => openDialogOf(page)?.querySelector(".dialog-error")?.textContent;

test("Rename team opens a dialog with the name in a field of 60 characters, focused", async () => {
  page = await bootTeam(teamInfo("admin"));
  page.press("#rename");
  expect(openDialogOf(page)?.querySelector("h2")?.textContent).toBe("Rename team");
  expect(field().value).toBe("Acme Engineering");
  expect(field().maxLength).toBe(60);
  expect(["autocapitalize", "autocorrect", "spellcheck"].map((a) => field().getAttribute(a))).toEqual(["none", "off", "false"]);
  expect(page.doc.activeElement).toBe(field());
  expect(openDialogOf(page)?.querySelector(`label[for="${field().id}"]`)?.textContent).toBe("Team name");
});

test("Save sends the name trimmed; on 200 the heading and the title change at once, whole, as text", async () => {
  const renamed = teamInfo("admin", { name: worstCase.teamName });
  page = await bootTeam(teamInfo("admin"), teamReply(renamed));
  page.press("#rename");
  typeInto(page, field(), `  ${worstCase.teamName}  `);
  dialogButton(page, "confirm").click();
  dialogButton(page, "confirm").click();
  expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  expect(dialogButton(page, "confirm").textContent).toBe("Saving…");
  const call = page.calls[2];
  expect([call?.url, call?.init.method, JSON.parse(String(call?.init.body))]).toEqual([`/api/teams/${T}`, "PATCH", { name: worstCase.teamName }]);
  await page.flush();
  expect(openDialogOf(page)).toBeNull();
  expect(page.$("#team-title").textContent).toBe(worstCase.teamName);
  expect(page.doc.title).toBe(`${worstCase.teamName} · teamusage`);
  expect(page.doc.activeElement).toBe(page.$("#rename"));
});

test.each([
  ["an empty name", "   "],
  // A text field drops a pasted line break by itself; a tab is a control character it keeps.
  ["a name with a tab", "Acme\tEngineering"],
])("%s is refused in the dialog, and nothing is sent", async (_name, value) => {
  page = await bootTeam(teamInfo("owner"));
  page.press("#rename");
  typeInto(page, field(), value);
  page.fire("dialog[open] form", "submit");
  await page.flush();
  expect(errorText()).toBe("Use 1 to 60 characters, with no line breaks.");
  expect(field().getAttribute("aria-invalid")).toBe("true");
  expect(page.calls).toHaveLength(2);
});

test("the same name closes the dialog and sends nothing", async () => {
  page = await bootTeam(teamInfo("owner"));
  page.press("#rename");
  typeInto(page, field(), " Acme Engineering ");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(openDialogOf(page)).toBeNull();
  expect(page.calls).toHaveLength(2);
});

test("the server's 'invalid name' is said as the page's own rule; another refusal in the page's sentence", async () => {
  page = await bootTeam(teamInfo("owner"), json({ error: "invalid name" }, 400), json({ error: "your role does not allow this" }, 403));
  page.press("#rename");
  typeInto(page, field(), "Beta");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(errorText()).toBe("Use 1 to 60 characters, with no line breaks.");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(errorText()).toBe("The server refused this request: your role does not allow this");
  expect(dialogButton(page, "confirm").disabled).toBe(false);
  expect(page.doc.activeElement).toBe(dialogButton(page, "confirm"));
});

test("a 401 closes the dialog and shows the sign-in panel", async () => {
  page = await bootTeam(teamInfo("owner"), nobody());
  page.press("#rename");
  typeInto(page, field(), "Beta");
  dialogButton(page, "confirm").click();
  await page.flush();
  expect(openDialogOf(page)).toBeNull();
  expect(page.shownViews()).toEqual(["signedOut"]);
});
