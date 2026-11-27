import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test } from "vitest";
import type { MeAnswer } from "../site/session.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { chromeOf, PLAIN, renderChrome, type Chrome } from "./chrome.js";

const T = "1111111111111111";
const OTHER = "2222222222222222";
const teamOf = (id: string, role: "owner" | "admin" | "viewer") => ({ id, name: `Team ${id.slice(0, 2)}`, role, dashboardAccess: "admins" as const });
const user = (...teams: ReturnType<typeof teamOf>[]): MeAnswer & { kind: "me" } => ({
  kind: "me",
  me: { kind: "user", githubId: 7_301, login: "acme-admin", teams },
});
const member: MeAnswer & { kind: "me" } = { kind: "me", me: { kind: "member", team: { id: OTHER, name: "Acme" }, memberId: 4 } };
const hosted = (team: string | null) => ({ kind: "hosted" as const, team });
const nav = { dashboard: `/dashboard?team=${T}`, team: `/team?team=${T}` };
const userAccount = { login: "acme-admin", teams: true, signOut: true };

test.each<[string, Parameters<typeof chromeOf>, ReturnType<typeof chromeOf>]>([
  ["self-hosted", [{ kind: "selfHosted" }, null], PLAIN],
  ["the demo", [{ kind: "demo" }, null], { ...PLAIN, sample: true }],
  ["nobody", [hosted(T), { kind: "none" }], { panel: "signedOut" }],
  ["a member", [hosted(null), member], { ...PLAIN, teamName: "Acme", account: { login: null, teams: false, signOut: true } }],
  ["a member, with someone else's ?team=", [hosted(T), member], { ...PLAIN, teamName: "Acme", account: { login: null, teams: false, signOut: true } }],
  ["an owner", [hosted(T), user(teamOf(T, "owner"))], { teamName: "Team 11", nav, account: userAccount, sample: false, team: T }],
  ["an admin", [hosted(T), user(teamOf(OTHER, "owner"), teamOf(T, "admin"))], { teamName: "Team 11", nav, account: userAccount, sample: false, team: T }],
  ["a viewer", [hosted(T), user(teamOf(T, "viewer"))], { teamName: "Team 11", nav: null, account: userAccount, sample: false, team: T }],
  ["a user without ?team= and one team", [hosted(null), user(teamOf(T, "owner"))], { teamName: "Team 11", nav, account: userAccount, sample: false, team: T }],
  ["a user without ?team= and several teams", [hosted(null), user(teamOf(T, "owner"), teamOf(OTHER, "viewer"))], { go: "/teams#all" }],
  ["a user without ?team= and no team", [hosted(null), user()], { go: "/teams#all" }],
  ["a user whose one team is not the one ?team= names", [hosted(T), user(teamOf(OTHER, "owner"))], { panel: "noTeam" }],
  ["a user with no team and ?team=", [hosted(T), user()], { panel: "noTeam" }],
])("%s", (_name, args, expected) => {
  expect(chromeOf(...args)).toEqual(expected);
});

const BODY = /<body>([\s\S]*)<\/body>/.exec(readFileSync(new URL("../../index.html", import.meta.url), "utf8"))?.[1] ?? "";
let win: Window | undefined;

function page(): Document {
  win = new Window();
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = BODY.replace(/<script[\s\S]*?<\/script>/g, "");
  return doc;
}

afterEach(async () => {
  await win?.happyDOM.close();
});

const visible = (doc: Document) => ["team-name", "team-nav", "sample", "account"].filter((id) => doc.getElementById(id)?.hidden === false);

test("self-hosted and the signed-out header show nothing but the name of the product", () => {
  const doc = page();
  renderChrome(doc, PLAIN, "en");
  expect(visible(doc)).toEqual([]);
});

test("the demo shows the sample chip and a link to create a team", () => {
  const doc = page();
  renderChrome(doc, { ...PLAIN, sample: true }, "en");
  expect(visible(doc)).toEqual(["sample"]);
  expect(doc.querySelector("#sample .sample-badge")?.textContent).toBe("Sample data");
  expect(doc.querySelector("#sample a")?.getAttribute("href")).toBe("/");
  expect(doc.querySelector("#sample a")?.textContent).toBe("Create a team");
  expect(doc.querySelector("#sample .sample-badge")?.tagName).toBe("SPAN");
});

test("a worst-case team name and login are drawn whole, as text", () => {
  const doc = page();
  const chrome: Chrome = { teamName: worstCase.teamName, nav, account: { login: worstCase.login, teams: true, signOut: true }, sample: false, team: T };
  renderChrome(doc, chrome, "en");
  expect(visible(doc)).toEqual(["team-name", "team-nav", "account"]);
  expect(doc.getElementById("team-name-text")?.textContent).toBe(worstCase.teamName);
  expect(doc.getElementById("account-text")?.textContent).toBe(`@${worstCase.login}`);
});

test("the nav links to this team's dashboard and team page, with the dashboard current", () => {
  const doc = page();
  renderChrome(doc, { teamName: "Acme", nav, account: userAccount, sample: false, team: T }, "ru");
  const links = [...doc.querySelectorAll<HTMLAnchorElement>("#team-nav a")];
  expect(links.map((a) => [a.getAttribute("href"), a.textContent, a.getAttribute("aria-current")])).toEqual([
    [nav.dashboard, "Дашборд", "page"],
    [nav.team, "Команда", null],
  ]);
  expect(doc.getElementById("your-teams")?.hidden).toBe(false);
  expect(doc.getElementById("sign-out")?.textContent).toBe("Выйти");
});

test("a member's account reads 'Signed in from your agent', with sign out and no link to a GitHub user's teams", () => {
  const doc = page();
  renderChrome(doc, { ...PLAIN, teamName: "Acme", account: { login: null, teams: false, signOut: true } }, "en");
  expect(doc.getElementById("account-text")?.textContent).toBe("Signed in from your agent");
  expect(doc.getElementById("your-teams")?.hidden).toBe(true);
  expect(doc.getElementById("sign-out")?.hidden).toBe(false);
});

test("a team name with markup stays text", () => {
  const doc = page();
  const evil = `<img src=x onerror="alert(1)">Acme`;
  renderChrome(doc, { ...PLAIN, teamName: evil, account: { login: evil, teams: true, signOut: true } }, "en");
  expect(doc.getElementById("team-name-text")?.textContent).toBe(evil);
  expect(doc.querySelector("header img")).toBeNull();
});
