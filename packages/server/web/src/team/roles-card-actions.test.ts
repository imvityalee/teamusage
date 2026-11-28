import { afterEach, describe, expect, test } from "vitest";
import { json, nobody } from "../site/page.fixture.js";
import { T } from "./page.fixture.js";
import { ADMIN, invitesReply, MY_ADMIN, MY_OWNER, OWNER, PENDING, PENDING_VIEWER, rolesReply, VIEWER } from "./roles.fixture.js";
import { actionIn, dialogButton, dialogError, dialogOf, mountRoles, rowOf, sentBy, type Mounted } from "./roles-card.fixture.js";

let m: Mounted;
afterEach(async () => m?.world.close());

const text = (el: Element) => el.textContent ?? "";
const noContent = () => new Response(null, { status: 204 });
/** An answer the test gives later, while the request is out. */
function deferred() {
  let answer!: (r: Response) => void;
  const reply = new Promise<Response>((resolve) => (answer = resolve));
  return { reply, answer };
}
const ownerWith = (...replies: Parameters<typeof mountRoles>[1]) =>
  mountRoles("owner", [rolesReply([MY_OWNER, ADMIN, VIEWER]), invitesReply([PENDING, PENDING_VIEWER]), ...replies]);
const press = (id: number, action: string) => actionIn(rowOf(m, id), action).click();

describe("Remove", () => {
  test("asks first, in the person's name, and sends nothing on Cancel", async () => {
    m = await ownerWith();
    press(VIEWER.githubId, "remove");
    expect(text(dialogOf(m)?.querySelector("h2") as Element)).toBe("Remove @nurlan-b?");
    expect(text(dialogOf(m) as Element)).toContain("They lose the team page and the dashboard at their next click.");
    dialogButton(m, "cancel").click();
    expect(dialogOf(m)).toBeNull();
    expect(sentBy(m)).toHaveLength(2);
    expect(m.world.doc.activeElement).toBe(actionIn(rowOf(m, VIEWER.githubId), "remove"));
  });

  test("in Russian", async () => {
    m = await mountRoles("owner", [rolesReply([MY_OWNER, VIEWER]), invitesReply([])], { lang: "ru" });
    press(VIEWER.githubId, "remove");
    expect(text(dialogOf(m)?.querySelector("h2") as Element)).toBe("Удалить @nurlan-b из команды?");
    expect(dialogButton(m, "confirm").textContent).toBe("Удалить");
  });

  test("a double press sends one request; the row goes at the answer, the count follows and the heading gets focus", async () => {
    const answer = deferred();
    m = await ownerWith(answer.reply);
    press(VIEWER.githubId, "remove");
    dialogButton(m, "confirm").click();
    dialogButton(m, "confirm").click();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(dialogButton(m, "confirm").textContent).toBe("Removing…");
    expect(sentBy(m)[2]).toBe(`DELETE /api/teams/${T}/roles/${VIEWER.githubId}`);
    answer.answer(noContent());
    await m.world.flush();
    expect(dialogOf(m)).toBeNull();
    expect(m.$(`[data-github-id="${VIEWER.githubId}"]`)).toBeNull();
    expect(text(m.$("#roles-title"))).toBe("Admins and viewers 1");
    expect(text(m.$("#roles-status"))).toBe("@nurlan-b was removed.");
    expect(m.world.doc.activeElement).toBe(m.$("#roles-title"));
    expect(sentBy(m)).toHaveLength(3);
  });

  test("a 404 'role not found' is not a dead end: the lists are read again and the stale row is gone", async () => {
    m = await ownerWith(json({ error: "role not found" }, 404), rolesReply([MY_OWNER, ADMIN]), invitesReply([PENDING, PENDING_VIEWER]));
    press(VIEWER.githubId, "remove");
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(dialogOf(m)).toBeNull();
    expect(sentBy(m).slice(3)).toEqual([`GET /api/teams/${T}/roles`, `GET /api/teams/${T}/invites`]);
    expect(m.$(`[data-github-id="${VIEWER.githubId}"]`)).toBeNull();
    expect(text(m.$("#roles-status"))).toBe("@nurlan-b was already gone. The list is up to date.");
  });

  test.each([
    ["a refusal of a role that has changed", json({ error: "your role does not allow this" }, 403), "The server refused this request: your role does not allow this"],
    ["the network", new TypeError("Failed to fetch"), "The server could not be reached."],
  ])("%s stays in the dialog that asked, with focus on its button and the row where it was", async (_name, reply, sentence) => {
    m = await ownerWith(reply);
    press(VIEWER.githubId, "remove");
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(text(dialogError(m))).toBe(sentence);
    expect(dialogError(m).getAttribute("role")).toBe("alert");
    expect(m.world.doc.activeElement).toBe(dialogButton(m, "confirm"));
    expect(dialogButton(m, "confirm").disabled).toBe(false);
    expect(rowOf(m, VIEWER.githubId)).not.toBeNull();
  });

  test("a 401 closes the dialog and is the page's", async () => {
    m = await ownerWith(nobody());
    press(VIEWER.githubId, "remove");
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(dialogOf(m)).toBeNull();
    expect(m.world.ctx.signedOut).toHaveBeenCalledTimes(1);
  });
});

describe("Make owner…", () => {
  test("asks first and says what changes", async () => {
    m = await ownerWith();
    press(ADMIN.githubId, "makeOwner");
    expect(text(dialogOf(m)?.querySelector("h2") as Element)).toBe("Make @aigerim-t the owner?");
    expect(text(dialogOf(m) as Element)).toContain("They become the owner and you become an admin. Only they can hand the team back.");
    expect(dialogButton(m, "confirm").textContent).toBe("Make owner");
  });

  test("on success the page is read again (the viewer's own role is not the card's to decide), once, and the card asks nothing itself", async () => {
    m = await ownerWith(noContent());
    press(ADMIN.githubId, "makeOwner");
    dialogButton(m, "confirm").click();
    dialogButton(m, "confirm").click();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    await m.world.flush();
    expect(sentBy(m)[2]).toBe(`POST /api/teams/${T}/owner`);
    expect(JSON.parse(String(m.world.calls[2]?.init.body))).toEqual({ user: ADMIN.githubId });
    expect(dialogOf(m)).toBeNull();
    expect(m.world.ctx.reload).toHaveBeenCalledTimes(1);
    expect(sentBy(m)).toHaveLength(3);
  });

  test.each([
    ["en", "@aigerim-t already owns 5 teams."],
    ["ru", "@aigerim-t уже владеет 5 командами."],
  ] as const)("a person who owns 5 teams already is said in the dialog (%s)", async (lang, sentence) => {
    m = await mountRoles("owner", [rolesReply([MY_OWNER, ADMIN]), invitesReply([]), json({ error: "that user already owns 5 teams" }, 409)], { lang });
    press(ADMIN.githubId, "makeOwner");
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(text(dialogError(m))).toBe(sentence);
    expect(m.world.ctx.reload).not.toHaveBeenCalled();
  });

  test("a person who is not an admin any more: said in the dialog, and the lists are read again", async () => {
    m = await ownerWith(json({ error: "ownership goes to an admin of this team" }, 409), rolesReply([MY_OWNER, VIEWER]), invitesReply([]));
    press(ADMIN.githubId, "makeOwner");
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(text(dialogError(m))).toBe("@aigerim-t is not an admin of this team any more, and ownership goes to an admin. The list is up to date.");
    expect(m.$(`[data-github-id="${ADMIN.githubId}"]`)).toBeNull();
    expect(text(m.$("#roles-status"))).toBe("");
  });

  test("a 404 'role not found' closes the dialog and reads the lists again", async () => {
    m = await ownerWith(json({ error: "role not found" }, 404), rolesReply([MY_OWNER, VIEWER]), invitesReply([]));
    press(ADMIN.githubId, "makeOwner");
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(dialogOf(m)).toBeNull();
    expect(m.$(`[data-github-id="${ADMIN.githubId}"]`)).toBeNull();
  });
});

describe("Leave team", () => {
  const admin = (...replies: Parameters<typeof mountRoles>[1]) => mountRoles("admin", [rolesReply([OWNER, MY_ADMIN]), ...replies]);

  test("asks first, naming the team, and leaves for the list of teams at the answer", async () => {
    m = await admin(noContent());
    actionIn(rowOf(m, MY_ADMIN.githubId), "leave").click();
    expect(text(dialogOf(m)?.querySelector("h2") as Element)).toBe("Leave Acme Engineering?");
    expect(text(dialogOf(m) as Element)).toContain("You lose the team page and the dashboard. The owner can invite you again.");
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(sentBy(m)[1]).toBe(`DELETE /api/teams/${T}/roles/${MY_ADMIN.githubId}`);
    expect(m.world.ctx.go).toHaveBeenCalledWith("/teams#all");
  });

  test("a role that is not found is a role already gone: the same way out", async () => {
    m = await admin(json({ error: "role not found" }, 404));
    actionIn(rowOf(m, MY_ADMIN.githubId), "leave").click();
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(m.world.ctx.go).toHaveBeenCalledWith("/teams#all");
  });

  test("a refusal stays in the dialog and nothing leaves", async () => {
    m = await admin(json({ error: "the owner cannot leave; hand the team over or delete it" }, 409));
    actionIn(rowOf(m, MY_ADMIN.githubId), "leave").click();
    dialogButton(m, "confirm").click();
    await m.world.flush();
    expect(text(dialogError(m))).toContain("The server refused this request: the owner cannot leave");
    expect(m.world.ctx.go).not.toHaveBeenCalled();
  });
});

describe("Cancel invite", () => {
  const cancelButton = (id: string) => m.$<HTMLButtonElement>(`[data-invite-id="${id}"] button`);

  test("a double press sends one request; the row goes at the answer and the heading gets focus", async () => {
    const answer = deferred();
    m = await ownerWith(answer.reply);
    const button = cancelButton(PENDING.id);
    button.click();
    button.click();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(button.disabled).toBe(true);
    expect(sentBy(m)[2]).toBe(`DELETE /api/teams/${T}/invites/${PENDING.id}`);
    answer.answer(noContent());
    await m.world.flush();
    expect(m.$(`[data-invite-id="${PENDING.id}"]`)).toBeNull();
    expect(m.$(`[data-invite-id="${PENDING_VIEWER.id}"]`)).not.toBeNull();
    expect(text(m.$("#roles-status"))).toBe("The invite was cancelled.");
    expect(m.world.doc.activeElement).toBe(m.$("#roles-title"));
  });

  test("an invite that is already gone: the lists are read again, not a dead end", async () => {
    m = await ownerWith(json({ error: "invite not found" }, 404), rolesReply([MY_OWNER, ADMIN, VIEWER]), invitesReply([PENDING_VIEWER]));
    cancelButton(PENDING.id).click();
    await m.world.flush();
    expect(sentBy(m).slice(3)).toEqual([`GET /api/teams/${T}/roles`, `GET /api/teams/${T}/invites`]);
    expect(m.$(`[data-invite-id="${PENDING.id}"]`)).toBeNull();
    expect(text(m.$("#roles-status"))).toBe("That invite was already gone. The list is up to date.");
  });

  test("a failure is told in the card's alert, the button is enabled again and has focus, and there is no Try again for it", async () => {
    m = await ownerWith(new TypeError("Failed to fetch"));
    cancelButton(PENDING.id).click();
    await m.world.flush();
    expect(text(m.$("#roles-error"))).toBe("Could not cancel the invite. The server could not be reached.");
    expect(m.$("#roles-retry").hidden).toBe(true);
    expect(cancelButton(PENDING.id).disabled).toBe(false);
    expect(m.world.doc.activeElement).toBe(cancelButton(PENDING.id));
  });

  test("two cancels in a row each write the status, so that the same words are heard twice", async () => {
    m = await ownerWith(noContent(), noContent());
    cancelButton(PENDING.id).click();
    await m.world.flush();
    const first = m.$("#roles-status").firstChild;
    expect(text(m.$("#roles-status"))).toBe("The invite was cancelled.");
    cancelButton(PENDING_VIEWER.id).click();
    await m.world.flush();
    expect(text(m.$("#roles-status"))).toBe("The invite was cancelled.");
    expect(m.$("#roles-status").firstChild).not.toBe(first);
  });

  test("painting again does not say the status again", async () => {
    m = await ownerWith(noContent());
    cancelButton(PENDING.id).click();
    await m.world.flush();
    const said = m.$("#roles-status").firstChild;
    m.card.paint();
    expect(m.$("#roles-status").firstChild).toBe(said);
  });

  test.each([
    ["a cancel", () => cancelButton(PENDING_VIEWER.id).click()],
    ["a removal", () => {
      press(VIEWER.githubId, "remove");
      dialogButton(m, "confirm").click();
    }],
  ])("the alert of a failed cancel is gone once %s works", async (_name, act) => {
    m = await ownerWith(new TypeError("Failed to fetch"), noContent());
    cancelButton(PENDING.id).click();
    await m.world.flush();
    expect(m.$("#roles-error").hidden).toBe(false);
    act();
    await m.world.flush();
    expect(m.$("#roles-error").hidden).toBe(true);
  });

  test("a 401 is the page's", async () => {
    m = await ownerWith(nobody());
    cancelButton(PENDING.id).click();
    await m.world.flush();
    expect(m.world.ctx.signedOut).toHaveBeenCalledTimes(1);
  });
});
