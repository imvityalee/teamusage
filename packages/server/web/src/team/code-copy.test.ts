import { afterEach, expect, test } from "vitest";
import { json } from "../site/page.fixture.js";
import { cardWorld, type World } from "./card.fixture.js";
import { codeCard, CODE_NOT_SHOWN } from "./code-card.js";
import { expectNowhereIn, teamInfo } from "./page.fixture.js";

/**
 * "Copy code" of a hidden code: Safari takes a clipboard write only inside the press, so the write starts at once with
 * the code still on its way (`ClipboardItem` with a promise); a browser without `ClipboardItem` writes once it came.
 */

const CODE = "9f8e7d6c5b4a39281706f5e4";

let world: World;
afterEach(async () => world?.close());

/** An answer the test gives when it wants. */
function later(): { reply: Promise<Response>; answer(res: Response): void } {
  let answer: (res: Response) => void = () => {};
  const reply = new Promise<Response>((resolve) => (answer = resolve));
  return { reply, answer };
}

function render(replies: Parameters<typeof cardWorld>[1], clipboardItem = true) {
  world = cardWorld(teamInfo("admin"), replies, { clipboardItem });
  const card = codeCard(world.ctx);
  world.doc.body.append(card.element);
  return card;
}

const $ = <E extends HTMLElement = HTMLElement>(sel: string) => world.doc.querySelector(sel) as E;

test("the clipboard write starts inside the press, before the code's request has answered, and ends holding the code", async () => {
  const { reply, answer } = later();
  const card = render([reply]);
  $("#code-copy").click();
  expect(world.calls).toHaveLength(1);
  expect(world.write).toHaveBeenCalledTimes(1);
  expect(world.held()).toBeNull();
  answer(json({ code: CODE }));
  await world.flush();
  expect(world.held()).toBe(CODE);
  expect(world.writeText).not.toHaveBeenCalled();
  expect($("#code-copy").textContent).toBe("Copied");
  expect(card.shown).toBeNull();
  expectNowhereIn(world, CODE);
});

test("a browser without ClipboardItem copies once the code came", async () => {
  render([json({ code: CODE })], false);
  $("#code-copy").click();
  await world.flush();
  expect(world.writeText).toHaveBeenCalledWith(CODE);
  expect(world.held()).toBe(CODE);
  expect($("#code-copy").textContent).toBe("Copied");
});

test.each([
  ["a code that can no longer be shown", json({ error: CODE_NOT_SHOWN }, 409), "This code can no longer be shown. Replace it to get a new one."],
  ["a network error", new TypeError("Failed to fetch"), "The server could not be reached."],
])("%s during a copy says the same as before, and the clipboard holds nothing", async (_name, reply, text) => {
  render([reply]);
  $("#code-copy").click();
  await world.flush();
  expect(world.write).toHaveBeenCalledTimes(1);
  expect(world.held()).toBeNull();
  expect($("#code-error").textContent).toBe(text);
  expect($("#code-copy").textContent).toBe("Copy code");
});

test("a 401 during a copy tells the page, and the clipboard holds nothing", async () => {
  render([json({ error: "unauthorized" }, 401)]);
  $("#code-copy").click();
  await world.flush();
  expect(world.ctx.signedOut).toHaveBeenCalledTimes(1);
  expect(world.held()).toBeNull();
  expect($("#code-error").hidden).toBe(true);
});
