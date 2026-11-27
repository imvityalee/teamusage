import { afterEach, expect, test } from "vitest";
import { json } from "../site/page.fixture.js";
import { cardWorld, type World } from "./card.fixture.js";
import { codeCard, CODE_NOT_SHOWN, HIDDEN_CODE } from "./code-card.js";
import { expectNowhereIn, teamInfo, T } from "./page.fixture.js";

const CODE = "9f8e7d6c5b4a39281706f5e4";
const NEW_CODE = "0123456789abcdef01234567";
const code = (value: string) => json({ code: value });

let world: World;
afterEach(async () => world?.close());

function render(...replies: Parameters<typeof cardWorld>[1]) {
  world = cardWorld(teamInfo("admin"), replies);
  const card = codeCard(world.ctx);
  world.doc.body.append(card.element);
  card.paint();
  return card;
}

const $ = <E extends HTMLElement = HTMLElement>(sel: string) => world.doc.querySelector(sel) as E;
const shownText = () => $("#code-value").textContent;
const dialogOpen = () => world.doc.querySelector<HTMLDialogElement>("dialog[open]");
const dialogButton = (action: string) => $<HTMLButtonElement>(`dialog[open] [data-action="${action}"]`);

const expectNowhere = (secret: string, inText = false) => expectNowhereIn(world, secret, inText);

test("nothing asks for the code until someone presses Show or Copy", async () => {
  const card = render();
  await world.flush();
  expect(world.calls).toEqual([]);
  expect(card.shown).toBeNull();
  expect(shownText()).toBe(`${HIDDEN_CODE}Hidden`);
  expect($("#code-value [aria-hidden=true]").textContent).toBe(HIDDEN_CODE);
});

test("Show asks for the code once, shows it and becomes Hide, with focus kept", async () => {
  const card = render(code(CODE));
  $("#code-show").click();
  await world.flush();
  expect(world.calls.map((c) => [c.url, c.init.method])).toEqual([[`/api/teams/${T}/code`, "GET"]]);
  expect(card.shown).toBe(CODE);
  expect(shownText()).toBe(CODE);
  expect($("#code-show").textContent).toBe("Hide");
  expect(world.doc.activeElement).toBe($("#code-show"));
  expectNowhere(CODE, true);
});

test("painting again does not draw the code box again, so its live region speaks once", async () => {
  const card = render(code(CODE));
  const dots = $("#code-value").firstChild;
  card.paint();
  expect($("#code-value").firstChild).toBe(dots);
  await card.show();
  const shownNode = $("#code-value").firstChild;
  card.paint();
  expect($("#code-value").firstChild).toBe(shownNode);
});

test("a double press on Show sends one request", async () => {
  render("pending");
  $("#code-show").click();
  $("#code-show").click();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect($<HTMLButtonElement>("#code-show").disabled).toBe(true);
});

test("Hide drops the code", async () => {
  const card = render(code(CODE));
  await card.show();
  expect(card.shown).toBe(CODE);
  card.hide();
  expect(card.shown).toBeNull();
  expect(world.doc.body.textContent).not.toContain(CODE);
  expect($("#code-show").textContent).toBe("Show");
  expectNowhere(CODE);
});

test("the Hide button drops the code from the page", async () => {
  render(code(CODE));
  $("#code-show").click();
  await world.flush();
  $("#code-show").click();
  expect(shownText()).toBe(`${HIDDEN_CODE}Hidden`);
  expectNowhere(CODE);
});

test("Copy copies without showing", async () => {
  const card = render(code(CODE));
  $("#code-copy").click();
  await world.flush();
  expect(world.writeText).toHaveBeenCalledWith(CODE);
  expect(card.shown).toBeNull();
  expect(shownText()).toBe(`${HIDDEN_CODE}Hidden`);
  expect($("#code-copy").textContent).toBe("Copied");
  await world.flush();
  expectNowhere(CODE);
});

test("Copy of a shown code copies it without asking again", async () => {
  const card = render(code(CODE));
  await card.show();
  $("#code-copy").click();
  await world.flush();
  expect(world.calls).toHaveLength(1);
  expect(world.writeText).toHaveBeenCalledWith(CODE);
});

test("a clipboard that refuses says so, and the code stays hidden", async () => {
  world = cardWorld(teamInfo("admin"), [code(CODE)], { refuseClipboard: true });
  const card = codeCard(world.ctx);
  world.doc.body.append(card.element);
  $("#code-copy").click();
  await world.flush();
  expect($("#code-error").textContent).toBe("Could not copy. Press Show and copy the code yourself.");
  expect(card.shown).toBeNull();
  expect(world.doc.activeElement).toBe($("#code-copy"));
});

test.each([
  ["a code that can no longer be shown", json({ error: CODE_NOT_SHOWN }, 409), "This code can no longer be shown. Replace it to get a new one."],
  ["another refusal", json({ error: "your role does not allow this" }, 403), "The server refused this request: your role does not allow this"],
  ["a 5xx", json({ error: "internal" }, 500), "The server could not be reached."],
  ["a network error", new TypeError("Failed to fetch"), "The server could not be reached."],
])("%s is said in the card, inside an alert", async (_name, reply, text) => {
  render(reply);
  $("#code-show").click();
  await world.flush();
  expect($("#code-error").textContent).toBe(text);
  expect($("#code-error").getAttribute("role")).toBe("alert");
  expect(shownText()).toBe(`${HIDDEN_CODE}Hidden`);
});

test("Replace code… asks first; Cancel sends nothing and gives focus back", async () => {
  render();
  $("#code-replace").click();
  expect(dialogOpen()?.textContent).toContain("Replace the team code?");
  expect(dialogOpen()?.textContent).toContain("People who have not joined yet need the new code.");
  dialogButton("cancel").click();
  expect(dialogOpen()).toBeNull();
  expect(world.calls).toEqual([]);
  expect(world.doc.activeElement).toBe($("#code-replace"));
});

test("after a replacement the card shows the new code and the old one is nowhere", async () => {
  const card = render(code(CODE), "pending");
  await card.show();
  $("#code-replace").click();
  dialogButton("confirm").click();
  expect(dialogButton("confirm").textContent).toBe("Replacing…");
  expect(dialogButton("confirm").disabled).toBe(true);
  dialogOpen()?.dispatchEvent(new world.win.Event("cancel", { cancelable: true }) as unknown as Event);
  expect(dialogOpen()).not.toBeNull();
  expect(world.calls.map((c) => [c.url, c.init.method])).toEqual([
    [`/api/teams/${T}/code`, "GET"],
    [`/api/teams/${T}/code/rotate`, "POST"],
  ]);
  card.replaced(NEW_CODE);
  expect(card.shown).toBe(NEW_CODE);
  expect(shownText()).toBe(NEW_CODE);
  expectNowhere(CODE);
});

test("a replacement whose answer comes while the old code is shown leaves the old code nowhere", async () => {
  const card = render(code(CODE), code(NEW_CODE));
  $("#code-show").click();
  await world.flush();
  expect(shownText()).toBe(CODE);
  $("#code-replace").click();
  dialogButton("confirm").click();
  await world.flush();
  expect(card.shown).toBe(NEW_CODE);
  expect(shownText()).toBe(NEW_CODE);
  expectNowhere(CODE);
});

test("a confirmed replacement closes the dialog and shows the new code", async () => {
  const card = render(code(NEW_CODE));
  $("#code-replace").click();
  dialogButton("confirm").click();
  await world.flush();
  expect(dialogOpen()).toBeNull();
  expect(card.shown).toBe(NEW_CODE);
  expect($("#code-show").textContent).toBe("Hide");
  expect(world.doc.activeElement).toBe($("#code-replace"));
});

test("a replacement that fails stays in the dialog, with its button back and focused", async () => {
  render(json({ error: "internal" }, 500));
  $("#code-replace").click();
  dialogButton("confirm").click();
  await world.flush();
  expect(dialogOpen()?.querySelector(".dialog-error")?.textContent).toBe("The server could not be reached.");
  expect(dialogButton("confirm").disabled).toBe(false);
  expect(dialogButton("confirm").textContent).toBe("Replace code");
  expect(world.doc.activeElement).toBe(dialogButton("confirm"));
});

test("a 401 to the replacement closes the dialog, drops the code and tells the page", async () => {
  const card = render(code(CODE), json({ error: "unauthorized" }, 401));
  await card.show();
  $("#code-replace").click();
  dialogButton("confirm").click();
  await world.flush();
  expect(dialogOpen()).toBeNull();
  expect(world.ctx.signedOut).toHaveBeenCalledTimes(1);
  expect(card.shown).toBeNull();
  expectNowhere(CODE);
});

test("a 401 to Show tells the page and shows nothing", async () => {
  const card = render(json({ error: "unauthorized" }, 401));
  $("#code-show").click();
  await world.flush();
  expect(world.ctx.signedOut).toHaveBeenCalledTimes(1);
  expect(card.shown).toBeNull();
});

test("the card is drawn again in Russian", async () => {
  const card = render();
  world.setLang("ru");
  card.paint();
  expect($("#code-card h2").textContent).toBe("Код команды");
  expect($("#code-show").textContent).toBe("Показать");
  expect(shownText()).toBe(`${HIDDEN_CODE}Скрыт`);
});
