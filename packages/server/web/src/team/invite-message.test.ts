import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { LANG_KEY } from "../lang.js";
import { cardWorld, type World } from "./card.fixture.js";
import { inviteMessage, messageText } from "./invite-message.js";
import { teamInfo } from "./page.fixture.js";

const ORIGIN = "http://localhost:8787";

let world: World;
afterEach(async () => world?.close());

function render(lang: "en" | "ru" = "en") {
  world = cardWorld(teamInfo("admin"), [], { lang });
  const card = inviteMessage(world.ctx);
  world.doc.body.append(card.element);
  card.paint();
  return card;
}

const $ = <E extends HTMLElement = HTMLElement>(sel: string) => world.doc.querySelector(sel) as E;
const pressed = () => [...world.doc.querySelectorAll<HTMLElement>("#invite-lang button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]);

test("the English message is board 3's, with this server's address and step 5 as corrected", () => {
  expect(messageText("en", ORIGIN)).toBe(
    [
      "teamusage: connect your machine (about 5 minutes)",
      "",
      "1. Install Node.js 22 or newer: https://nodejs.org",
      "2. In Claude Code, type:",
      "     /plugin marketplace add imvityalee/teamusage",
      "     /plugin install teamusage@teamusage",
      "3. When it asks for the settings, enter:",
      "     Server URL: http://localhost:8787",
      "     Team code: the code I sent you privately",
      "     Your name and Your email: your work name and work email",
      "4. Start a new Claude Code session. Your usage is sent automatically from now on.",
      '5. Check it: ask Claude "send my usage", then "open the team dashboard".',
      "",
      "Using Codex? Run once in a terminal: npx -y teamusage setup",
    ].join("\n"),
  );
});

test("the install step is the README's two commands, in both languages", () => {
  const readme = readFileSync(new URL("../../../../../README.md", import.meta.url), "utf8");
  const commands = ["/plugin marketplace add imvityalee/teamusage", "/plugin install teamusage@teamusage"];
  for (const command of commands) {
    expect(readme).toContain(`     ${command}\n`);
    expect(messageText("en", ORIGIN)).toContain(`     ${command}\n`);
    expect(messageText("ru", ORIGIN)).toContain(`     ${command}\n`);
  }
});

test.each(["en", "ru"] as const)("the %s message never holds a team code", (lang) => {
  expect(messageText(lang, ORIGIN)).not.toMatch(/[0-9a-f]{24}/i);
  render(lang);
  expect($("#invite-card").textContent).not.toMatch(/[0-9a-f]{24}/i);
});

test("the card draws the message in the page's language at first, with this server's address", () => {
  render("ru");
  expect($("#invite-text").textContent).toBe(messageText("ru", ORIGIN));
  expect($("#invite-text").getAttribute("lang")).toBe("ru");
  expect(pressed()).toEqual([
    ["EN", "false"],
    ["RU", "true"],
  ]);
});

test("its own EN/RU control changes the message only, and stores nothing", () => {
  const card = render("en");
  $<HTMLButtonElement>("#invite-lang button[data-message-lang=ru]").click();
  expect($("#invite-text").textContent).toBe(messageText("ru", ORIGIN));
  expect(pressed()).toEqual([
    ["EN", "false"],
    ["RU", "true"],
  ]);
  expect(world.ctx.lang()).toBe("en");
  expect(world.doc.documentElement.lang).not.toBe("ru");
  expect(world.win.localStorage.getItem(LANG_KEY)).toBeNull();
  expect(world.win.localStorage.length).toBe(0);
  card.paint();
  expect($("#invite-card h2").textContent).toBe("Invite message");
});

test("until its control is used, the message follows the page's language; afterwards it keeps its own", () => {
  const card = render("en");
  world.setLang("ru");
  card.paint();
  expect($("#invite-text").textContent).toBe(messageText("ru", ORIGIN));
  $<HTMLButtonElement>("#invite-lang button[data-message-lang=en]").click();
  world.setLang("ru");
  card.paint();
  expect($("#invite-text").textContent).toBe(messageText("en", ORIGIN));
  expect($("#invite-card h2").textContent).toBe("Сообщение для команды");
});

test("Copy message copies the message as shown and says so", async () => {
  render("en");
  $<HTMLButtonElement>("#invite-lang button[data-message-lang=ru]").click();
  $("#invite-copy").click();
  await world.flush();
  expect(world.writeText).toHaveBeenCalledWith(messageText("ru", ORIGIN));
  expect($("#invite-copy").textContent).toBe("Copied");
  expect(world.calls).toEqual([]);
});

test("a clipboard that refuses says so in the card", async () => {
  world = cardWorld(teamInfo("admin"), [], { refuseClipboard: true });
  const card = inviteMessage(world.ctx);
  world.doc.body.append(card.element);
  card.paint();
  $("#invite-copy").click();
  await world.flush();
  expect($("#invite-error").textContent).toBe("Could not copy. Select the message and copy it yourself.");
  expect($("#invite-error").hidden).toBe(false);
});
