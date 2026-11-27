import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import type { Lang } from "../lang.js";
import { codeSignIn } from "./code-sign-in.js";

const BODY = /<body>([\s\S]*)<\/body>/.exec(readFileSync(new URL("../../index.html", import.meta.url), "utf8"))?.[1] ?? "";
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let win: Window;

/** The code form of index.html, wired by `codeSignIn`, with the login answered by `reply`. */
function form(reply: Response, lang: Lang = "en") {
  win = new Window();
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = BODY.replace(/<script[\s\S]*?<\/script>/g, "");
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => reply);
  vi.stubGlobal("fetch", fetch);
  const signedIn = vi.fn(async () => {});
  const view = codeSignIn(doc, { lang: () => lang, signedIn });
  const submit = async (code: string) => {
    (doc.getElementById("invite") as HTMLInputElement).value = code;
    doc.getElementById("login-form")?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const message = () => doc.getElementById("login-msg") as HTMLElement;
  return { doc, fetch, signedIn, view, submit, message };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await win.happyDOM.close();
});

test("a sign-in from another address names TEAMUSAGE_PUBLIC_URL, in both languages", async () => {
  const en = form(json({ error: "cross-site request refused" }, 403));
  await en.submit("team-code-0123");
  expect(en.message().hidden).toBe(false);
  expect(en.message().textContent).toBe(
    "This server accepts sign-in only from its own address. Ask whoever runs it to check TEAMUSAGE_PUBLIC_URL.",
  );
  expect(en.signedIn).not.toHaveBeenCalled();
  expect(en.doc.activeElement?.id).toBe("invite");
  await win.happyDOM.close();

  const ru = form(json({ error: "cross-site request refused" }, 403), "ru");
  await ru.submit("team-code-0123");
  expect(ru.message().textContent).toBe(
    "Этот сервер разрешает вход только со своего адреса. Попросите того, кто им управляет, проверить настройку TEAMUSAGE_PUBLIC_URL.",
  );
});

test("a wrong code is still a wrong code", async () => {
  const f = form(json({ error: "invalid invite code" }, 403));
  await f.submit("team-code-0123");
  expect(f.message().textContent).toBe("Wrong invite code.");
});

test("a code that opens the dashboard clears the message and hands over; the field is empty at once", async () => {
  const f = form(new Response(null, { status: 204 }));
  await f.submit("team-code-0123");
  expect(f.signedIn).toHaveBeenCalledTimes(1);
  expect(f.message().hidden).toBe(true);
  expect((f.doc.getElementById("invite") as HTMLInputElement).value).toBe("");
  expect(JSON.parse(f.fetch.mock.calls[0]?.[1].body as string)).toEqual({ inviteCode: "team-code-0123" });
});

test("an empty field sends nothing", async () => {
  const f = form(new Response(null, { status: 204 }));
  await f.submit("");
  expect(f.fetch).not.toHaveBeenCalled();
});
