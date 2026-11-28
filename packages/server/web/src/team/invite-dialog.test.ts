import { afterEach, describe, expect, test } from "vitest";
import { json, nobody } from "../site/page.fixture.js";
import { expectNowhereIn, T } from "./page.fixture.js";
import { invitesReply, MY_OWNER, PENDING, rolesReply, TOKEN } from "./roles.fixture.js";
import { dialogButton, dialogError, dialogOf, mountRoles, sentBy, type Mounted } from "./roles-card.fixture.js";

let m: Mounted;
afterEach(async () => m?.world.close());

const text = (el: Element | null) => el?.textContent ?? "";
const created = () => json({ invite: PENDING, token: TOKEN }, 201);
const LINK = `http://localhost:8787/invite#${TOKEN}`;

async function openFor(replies: Parameters<typeof mountRoles>[1], o: Parameters<typeof mountRoles>[2] = {}) {
  m = await mountRoles("owner", [rolesReply([MY_OWNER]), invitesReply([]), ...replies], o);
  m.$("#roles-invite").click();
}
const choose = (role: "admin" | "viewer") => {
  const input = m.$<HTMLInputElement>(`dialog[open] input[value="${role}"]`);
  input.checked = true;
  input.dispatchEvent(new m.world.win.Event("change", { bubbles: true }) as unknown as Event);
};
const createLink = async () => {
  dialogButton(m, "confirm").click();
  await m.world.flush();
};
const codeBox = () => m.world.doc.querySelector("dialog[open] .code");

describe("the choice of a role", () => {
  test("two roles with what each can do, neither chosen, and Create link off", async () => {
    await openFor([]);
    const dialog = dialogOf(m) as HTMLDialogElement;
    expect(text(dialog.querySelector("h2"))).toBe("Invite someone");
    const options = [...dialog.querySelectorAll("label.option")].map(text);
    expect(options).toEqual([
      "AdminOpens the dashboard and the team page; can replace the code, rename the team and remove members and machines.",
      "ViewerOpens the dashboard only.",
    ]);
    expect([...dialog.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((i) => i.checked)).toEqual([false, false]);
    expect(dialogButton(m, "confirm").textContent).toBe("Create link");
    expect(dialogButton(m, "confirm").disabled).toBe(true);
    expect(m.world.doc.activeElement?.getAttribute("value")).toBe("admin");
  });

  test("Enter with no role chosen sends nothing; choosing one turns the button on", async () => {
    await openFor([created()]);
    dialogOf(m)?.querySelector("form")?.dispatchEvent(new m.world.win.Event("submit", { cancelable: true }) as unknown as Event);
    await m.world.flush();
    expect(sentBy(m)).toHaveLength(2);
    choose("viewer");
    expect(dialogButton(m, "confirm").disabled).toBe(false);
  });

  test("the two roles are the same choice list as the dashboard access dialog: its classes", async () => {
    await openFor([]);
    expect(dialogOf(m)?.querySelector("fieldset.options")).not.toBeNull();
  });
});

describe("the link", () => {
  test("is made for the chosen role, once, and shown with what to know about it; Copy link has focus", async () => {
    await openFor([created()]);
    choose("admin");
    dialogButton(m, "confirm").click();
    dialogButton(m, "confirm").click();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(dialogButton(m, "confirm").textContent).toBe("Creating…");
    await m.world.flush();
    expect(sentBy(m)[2]).toBe(`POST /api/teams/${T}/invites`);
    expect(JSON.parse(String(m.world.calls[2]?.init.body))).toEqual({ role: "admin" });
    expect(text(codeBox())).toBe(LINK);
    const dialog = text(dialogOf(m));
    expect(dialog).toContain("Copy this link now. It is not shown again.");
    expect(dialog).toContain("It works once, for 7 days, for whichever GitHub account opens it first. Send it privately.");
    expect(dialogButton(m, "confirm").textContent).toBe("Copy link");
    expect(dialogButton(m, "cancel").textContent).toBe("Done");
    expect(m.world.doc.activeElement).toBe(dialogButton(m, "confirm"));
  });

  test("in Russian the note says the days with their own form", async () => {
    await openFor([created()], { lang: "ru" });
    choose("admin");
    await createLink();
    expect(text(dialogOf(m))).toContain("Ссылка сработает один раз в течение 7 дней — для того аккаунта GitHub, с которого её откроют первым. Отправьте её в личном сообщении.");
  });

  test("the new invite is in the list behind the dialog, with its end day", async () => {
    await openFor([created()]);
    choose("admin");
    await createLink();
    expect(text(m.$(`[data-invite-id="${PENDING.id}"]`))).toContain("Admin invite, not used yet");
    expect(text(m.$(`[data-invite-id="${PENDING.id}"]`))).toContain("ends on Dec 4, 2026");
    expect(text(m.$("#roles-status"))).toBe("The invite was created.");
  });

  test("Copy link copies inside the press: the link is already in hand, and the button says so", async () => {
    await openFor([created()]);
    choose("admin");
    await createLink();
    dialogButton(m, "confirm").click();
    expect(m.world.writeText).toHaveBeenCalledTimes(1);
    expect(m.world.writeText).toHaveBeenCalledWith(LINK);
    await m.world.flush();
    expect(m.world.held()).toBe(LINK);
    expect(dialogButton(m, "confirm").textContent).toBe("Copied");
  });

  test("a clipboard that refuses is said in the dialog, and the link stays to be selected", async () => {
    await openFor([created()], { refuseClipboard: true });
    choose("admin");
    await createLink();
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(text(dialogError(m))).toBe("Could not copy. Select the link and copy it yourself.");
    expect(text(codeBox())).toBe(LINK);
  });
});

describe("the token is dropped when the dialog closes", () => {
  test.each([
    ["Done", () => dialogButton(m, "cancel").click()],
    ["Escape", () => dialogOf(m)?.dispatchEvent(new m.world.win.Event("cancel", { cancelable: true }) as unknown as Event)],
  ])("closing with %s leaves it in no element, attribute, title, storage, address, request or console", async (_name, close) => {
    await openFor([created()]);
    choose("admin");
    await createLink();
    expectNowhereIn(m.world, TOKEN, true);
    close();
    await m.world.flush();
    expect(dialogOf(m)).toBeNull();
    expectNowhereIn(m.world, TOKEN);
    expect(m.world.doc.activeElement).toBe(m.$("#roles-invite"));
  });

  test("the link is out of the document at once, not when the closing motion ends", async () => {
    await openFor([created()]);
    choose("admin");
    await createLink();
    const dialog = dialogOf(m) as HTMLDialogElement;
    // A browser runs a closing motion: the dialog stays attached until it finishes. This one never does.
    dialog.getAnimations = (() => [{ finished: new Promise(() => {}) }]) as unknown as typeof dialog.getAnimations;
    dialogButton(m, "cancel").click();
    await m.world.flush();
    expect(dialog.isConnected).toBe(true);
    expect(dialog.textContent).not.toContain(TOKEN);
    expectNowhereIn(m.world, TOKEN);
  });

  test("a later open starts from the choice again and shows no link", async () => {
    await openFor([created()]);
    choose("admin");
    await createLink();
    dialogButton(m, "cancel").click();
    m.$("#roles-invite").click();
    expect(codeBox()).toBeNull();
    expect(dialogButton(m, "confirm").textContent).toBe("Create link");
    expect(dialogButton(m, "confirm").disabled).toBe(true);
    expectNowhereIn(m.world, TOKEN);
  });

  test("the link is not written into the address or the storage while it is shown", async () => {
    await openFor([created()]);
    choose("viewer");
    await createLink();
    expect(m.world.win.location.href).not.toContain(TOKEN);
    expect(m.world.win.location.hash).toBe("");
    expect(m.world.win.sessionStorage.length + m.world.win.localStorage.length).toBe(0);
  });
});

describe("what the server refuses", () => {
  const refused = (error: string, status = 409) => json({ error }, status);

  test.each([
    ["en", "this team has 20 pending invites; cancel one first", "This team has 20 pending invitations. Cancel one first."],
    ["ru", "this team has 20 pending invites; cancel one first", "У команды уже 20 неиспользованных приглашений. Сначала отмените одно из них."],
  ] as const)("(%s) %s is said in the dialog, which stays with focus on its button", async (lang, error, sentence) => {
    await openFor([refused(error)], { lang });
    choose("admin");
    await createLink();
    expect(text(dialogError(m))).toBe(sentence);
    expect(dialogError(m).getAttribute("role")).toBe("alert");
    expect(m.world.doc.activeElement).toBe(dialogButton(m, "confirm"));
    expect(dialogButton(m, "confirm").disabled).toBe(false);
    expect(codeBox()).toBeNull();
  });

  test("an unknown refusal is in the page's own sentence with the server's text as text; the network and a 5xx are 'could not be reached'", async () => {
    await openFor([refused("<i>try later</i>", 403), new TypeError("Failed to fetch"), json({ error: "boom" }, 500)]);
    choose("admin");
    await createLink();
    expect(text(dialogError(m))).toBe("The server refused this request: <i>try later</i>");
    expect(dialogError(m).querySelector("i")).toBeNull();
    await createLink();
    expect(text(dialogError(m))).toBe("The server could not be reached.");
    await createLink();
    expect(text(dialogError(m))).toBe("The server could not be reached.");
    expect(sentBy(m)).toHaveLength(5);
  });

  test("a 401 closes the dialog and is the page's", async () => {
    await openFor([nobody()]);
    choose("admin");
    await createLink();
    expect(dialogOf(m)).toBeNull();
    expect(m.world.ctx.signedOut).toHaveBeenCalledTimes(1);
  });
});
