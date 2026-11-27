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
      "     Invite code: the team code I sent you privately",
      "     Your name and Your email: your work name and work email",
      "4. Start a new Claude Code session. Your usage is sent automatically from now on.",
      '5. Check it: ask Claude "send my usage", then "open the team dashboard".',
      "",
      "Using Codex? Run once in a terminal: npx -y teamusage@0.3.1 setup",
    ].join("\n"),
  );
});

const repoFile = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

/** The settings fields the message names: the titles before ":" in step 3, "Your name and Your email" being two. */
function namedFields(message: string): string[] {
  const lines = message.split("\n");
  const step3 = lines.slice(lines.findIndex((l) => l.startsWith("3.")) + 1, lines.findIndex((l) => l.startsWith("4.")));
  return step3.flatMap((l) => (l.split(":")[0] ?? "").trim().split(/ and | и /));
}

/** The message's commands: the two `/plugin` lines and the `npx` command of the Codex line. */
const commandsOf = (message: string): string[] => [...message.matchAll(/(\/plugin [^\n]+|npx -y [^\n]+)/g)].map((m) => (m[1] ?? "").trim());

test.each(["en", "ru"] as const)("the %s message names only fields the plugin asks for, and only commands of the README", (lang) => {
  const plugin = JSON.parse(repoFile("plugin/.claude-plugin/plugin.json")) as { userConfig: Record<string, { title: string }> };
  const titles = Object.values(plugin.userConfig).map((field) => field.title);
  const message = messageText(lang, ORIGIN);
  expect(namedFields(message)).toEqual(["Server URL", "Invite code", "Your name", "Your email"]);
  for (const field of namedFields(message)) expect(titles).toContain(field);
  const readme = repoFile("README.md");
  expect(commandsOf(message)).toEqual(["/plugin marketplace add imvityalee/teamusage", "/plugin install teamusage@teamusage", "npx -y teamusage@0.3.1 setup"]);
  for (const command of commandsOf(message)) expect(readme).toContain(`     ${command}\n`);
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
