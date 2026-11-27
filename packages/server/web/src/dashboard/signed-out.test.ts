import { Window } from "happy-dom";
import { afterEach, expect, test } from "vitest";
import { renderSignedOut } from "./signed-out.js";

let win: Window;
const newDoc = () => {
  win = new Window();
  return win.document as unknown as Document;
};

afterEach(async () => {
  await win.happyDOM.close();
});

const links = (el: HTMLElement) => [...el.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);

test("signed out: a heading, the way in for a member from their agent, and the GitHub sign-in that lands on /teams", () => {
  const panel = renderSignedOut(newDoc(), "en", "signedOut");
  expect(panel.querySelector("h2")?.textContent).toBe("Sign in to see this dashboard");
  expect(panel.textContent).toContain("Team member? Open it from your coding agent.");
  expect(links(panel)).toEqual([
    ["Sign in with GitHub", "/auth/github/start?to=teams"],
    ["Open it from your coding agent.", "/open"],
  ]);
});

test("no team: the sentence and a link to the person's teams", () => {
  const panel = renderSignedOut(newDoc(), "en", "noTeam");
  expect(panel.querySelector("h2")?.textContent).toBe("This team was not found, or you no longer have a role in it.");
  expect(links(panel)).toEqual([["Your teams", "/teams#all"]]);
});

test("each panel is announced from its wrapper, never from its heading", () => {
  for (const kind of ["signedOut", "noTeam"] as const) {
    const panel = renderSignedOut(newDoc(), "en", kind);
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.querySelector("h2")?.hasAttribute("role")).toBe(false);
  }
});

test("in Russian", () => {
  const panel = renderSignedOut(newDoc(), "ru", "signedOut");
  expect(panel.querySelector("h2")?.textContent).toBe("Войдите, чтобы открыть этот дашборд");
  expect(links(panel).map(([text]) => text)).toEqual(["Войти через GitHub", "Откройте дашборд из своего агента."]);
  expect(renderSignedOut(newDoc(), "ru", "noTeam").querySelector("h2")?.textContent).toBe(
    "Команда не найдена, или у вас в ней больше нет роли.",
  );
});
