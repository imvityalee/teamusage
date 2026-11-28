import { afterEach, describe, expect, test } from "vitest";
import { json, nobody, type Reply } from "../site/page.fixture.js";
import { machine, member, rowsOf, TODAY, worstCase } from "./members.fixture.js";
import { T } from "./page.fixture.js";
import { mount, NEW_CODE, ONE_MACHINE, ONE_MEMBER, removed, SEVERAL, type Mounted } from "./removal-dialog.fixture.js";

let m: Mounted;
afterEach(async () => m?.world.close());

const answerLater = () => {
  let answer: (r: Response) => void = () => {};
  const reply = new Promise<Response>((resolve) => (answer = resolve));
  return { reply, answer };
};

describe("board 11", () => {
  test("the box is ticked when the dialog opens, and again the next time after it was unticked", async () => {
    m = mount([]);
    m.open(ONE_MEMBER);
    expect(m.box().checked).toBe(true);
    m.box().click();
    expect(m.box().checked).toBe(false);
    await m.press("Cancel");
    m.open(ONE_MEMBER);
    expect(m.box().checked).toBe(true);
  });

  test("one member: the heading, the line under it, what is deleted and the box, with Cancel focused", () => {
    m = mount([]);
    m.open(ONE_MEMBER);
    expect(m.within("h2")?.textContent).toBe("Remove Nurlan Asanov?");
    expect(m.text()).toContain("nurlan.asanov@acme.example, 1 machine, last sync 41 days ago");
    expect(m.text()).toContain("Their machine and all of their usage history are deleted, and their browser is signed out of the dashboard. Nobody else is signed out. This cannot be undone.");
    expect(m.within("label")?.textContent).toBe(
      "Replace the team codeTheir plugin still holds the current code and would join again at its next sync. A new code keeps them out. Machines that already joined keep sending, and only people who join later need the new code.",
    );
    expect(m.button("Remove member")).not.toBeNull();
    expect(m.world.doc.activeElement).toBe(m.button("Cancel"));
  });

  test("several members and one machine have their own words", () => {
    m = mount([]);
    m.open(SEVERAL);
    expect(m.within("h2")?.textContent).toBe("Remove 2 members?");
    expect(m.text()).toContain("Their plugins still hold the current code");
    expect(m.button("Remove members")).not.toBeNull();
    m.button("Cancel")!.click();
    m.open(ONE_MACHINE);
    expect(m.within("h2")?.textContent).toBe("Remove the machine nurlan-laptop?");
    expect(m.text()).toContain("Nurlan Asanov's machine.");
    expect(m.button("Remove machine")).not.toBeNull();
  });

  test("Cancel sends nothing and gives focus back to the button that opened it", async () => {
    m = mount([]);
    m.open();
    await m.press("Cancel");
    expect(m.dialog()).toBeNull();
    expect(m.world.calls).toHaveLength(0);
    expect(m.world.doc.activeElement).toBe(m.opener);
  });

  test("worst-case names, emails and labels are drawn whole, as text", () => {
    const longest = worstCase.people[3]!;
    const who = rowsOf([member(9, [machine(TODAY, worstCase.machineLabel)], { name: `<b>${longest.name}</b>`, email: worstCase.people[4]!.email })])[0]!;
    m = mount([], { lang: "ru" });
    m.open({ members: [who], machines: [] });
    expect(m.within("h2")?.textContent).toBe(`Удалить участника <b>${longest.name}</b>?`);
    expect(m.text()).toContain(worstCase.people[4]!.email);
    expect(m.dialog()?.querySelector("b")).toBeNull();
    m.button("Отмена")?.click();
    m.open({ members: [], machines: [{ member: who, machine: who.machines[0]! }] });
    expect(m.within("h2")?.textContent).toBe(`Удалить устройство ${worstCase.machineLabel}?`);
  });

  test("in Russian", () => {
    m = mount([], { lang: "ru" });
    m.open(SEVERAL);
    expect(m.within("h2")?.textContent).toBe("Удалить 2 участников?");
    expect(m.button("Удалить участников")).not.toBeNull();
    expect(m.within("label")?.textContent).toContain("Заменить код команды");
  });
});

describe("confirming", () => {
  test("confirming sends the member and rotateCode true, then shows the new code with a way to copy it", async () => {
    m = mount([removed(1, 1, NEW_CODE)]);
    m.open(ONE_MEMBER);
    await m.press("Remove member");
    expect(m.sent()).toEqual([{ method: "POST", path: `/api/teams/${T}/removals`, body: { members: [7], machines: [], rotateCode: true } }]);
    expect(m.dialog()?.textContent).toContain(NEW_CODE);
    expect(m.button("Copy code")).not.toBeNull();
    expect(m.onDone).toHaveBeenCalledWith({ kind: "done", removed: { members: 1, machines: 1 }, code: NEW_CODE });
  });

  test("unticked, it sends rotateCode false, shows no code, closes and gives focus to the card's heading", async () => {
    m = mount([removed(1, 1)]);
    m.open(ONE_MEMBER);
    m.box().click();
    await m.press("Remove member");
    expect(m.sent()[0]?.body).toEqual({ members: [7], machines: [], rotateCode: false });
    expect(m.dialog()).toBeNull();
    expect(m.onDone).toHaveBeenCalledWith({ kind: "done", removed: { members: 1, machines: 1 }, code: null });
    expect(m.world.doc.activeElement).toBe(m.refocus);
  });

  test("the request carries the box as it stands at the press: unticked and ticked again is true", async () => {
    m = mount([removed(0, 1)]);
    m.open(ONE_MACHINE);
    m.box().click();
    m.box().click();
    await m.press("Remove machine");
    expect(m.sent()[0]?.body).toEqual({ members: [], machines: [ONE_MACHINE.machines[0]!.machine.id], rotateCode: true });
  });

  test("while the request is out, Escape, the backdrop and a second press do nothing", async () => {
    const later = answerLater();
    m = mount([later.reply]);
    m.open();
    m.button("Remove member")!.click();
    const busy = m.within("[data-action=confirm]") as HTMLButtonElement;
    expect(busy.textContent).toBe("Removing…");
    expect(busy.disabled).toBe(true);
    expect(m.box().disabled).toBe(true);
    busy.click();
    m.within("form")?.dispatchEvent(new m.world.win.Event("submit", { cancelable: true }) as unknown as Event);
    m.escape();
    m.backdrop();
    (m.within("[data-action=cancel]") as HTMLButtonElement).click();
    await m.world.flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(m.dialog()?.open).toBe(true);
    later.answer(removed(1, 1, NEW_CODE));
    await m.world.flush();
    expect(m.text()).toContain(NEW_CODE);
  });

  test("a 401 closes the dialog and hands over to the page's sign-in", async () => {
    m = mount([nobody()]);
    m.open();
    await m.press("Remove member");
    expect(m.dialog()).toBeNull();
    expect(m.onSignedOut).toHaveBeenCalledTimes(1);
    expect(m.onDone).not.toHaveBeenCalled();
  });
});

describe("a removal that does not finish", () => {
  test.each<[string, Reply]>([
    ["500", json({}, 500)],
    ["403", json({ error: "your role does not allow this" }, 403)],
    ["404", json({ error: "team not found" }, 404)],
    ["network", new TypeError("offline")],
  ])("a removal that answers %s keeps the dialog open and says part of the history may be gone", async (_status, reply) => {
    m = mount([reply]);
    m.open();
    await m.press("Remove member");
    expect(m.dialog()?.open).toBe(true);
    expect(m.dialog()?.textContent).toContain("The removal stopped before it finished");
    expect(m.within("[role=alert]")?.textContent).toContain("The removal stopped before it finished");
    expect(m.onDone).not.toHaveBeenCalled();
  });

  test.each<[string, Reply]>([
    ["500", json({}, 500)],
    ["network", new TypeError("offline")],
  ])("after a %s the page cannot know whether the code was replaced and does not say it is unchanged", async (_status, reply) => {
    m = mount([reply]);
    m.open();
    await m.press("Remove member");
    expect(m.text()).toContain("Part of the usage history may already be deleted, and the page could not learn whether the removal finished. Run it again to finish.");
    expect(m.text()).not.toContain("unchanged");
    expect(m.button("Run it again")).not.toBeNull();
    expect(m.button("Close")).not.toBeNull();
    expect(m.world.doc.activeElement).toBe(m.button("Run it again"));
  });

  test("after the server's own 404 the member is still there and the code is unchanged", async () => {
    m = mount([json({ error: "team not found" }, 404)]);
    m.open();
    await m.press("Remove member");
    expect(m.text()).toContain("Part of their usage history is already deleted. The member is still in the list and the team code is unchanged. Run it again to finish.");
  });

  test("a 403 says the role no longer allows it and offers only Close, which has the page read the role again", async () => {
    m = mount([json({ error: "your role does not allow this" }, 403)]);
    m.open(SEVERAL);
    await m.press("Remove members");
    expect(m.text()).toContain("The members are still in the list and the team code is unchanged. Your role no longer allows this.");
    expect(m.text()).not.toContain("Run it again");
    expect(m.button("Run it again")).toBeNull();
    expect(m.within("[data-action=confirm]")?.hidden).toBe(true);
    expect(m.onRoleLost).not.toHaveBeenCalled();
    await m.press("Close");
    expect(m.dialog()).toBeNull();
    expect(m.onRoleLost).toHaveBeenCalledTimes(1);
  });

  test("Run it again sends the same people once more, with the box as it stands then", async () => {
    m = mount([json({}, 500), json({}, 502), removed(1, 1)]);
    m.open();
    await m.press("Remove member");
    await m.press("Run it again");
    m.box().click();
    await m.press("Run it again");
    const [first, second, third] = m.sent();
    expect(second).toEqual(first);
    expect(third?.body).toEqual({ members: [7], machines: [], rotateCode: false });
    expect(m.dialog()).toBeNull();
    expect(m.onDone).toHaveBeenCalledWith({ kind: "done", removed: { members: 1, machines: 1 }, code: null });
  });

  test("a run again that finds the members already gone ends as a success would", async () => {
    m = mount([new TypeError("offline"), removed(0, 0, NEW_CODE)]);
    m.open();
    await m.press("Remove member");
    await m.press("Run it again");
    expect(m.onDone).toHaveBeenCalledWith({ kind: "done", removed: { members: 0, machines: 0 }, code: NEW_CODE });
    expect(m.text()).toContain(NEW_CODE);
  });

  test("each stop is said anew: the alert is a new node", async () => {
    m = mount([json({}, 500), json({}, 500)]);
    m.open();
    await m.press("Remove member");
    const said = m.within("[role=alert]")?.firstChild;
    await m.press("Run it again");
    expect(m.within("[role=alert]")?.firstChild).not.toBe(said);
    expect(m.within("[role=alert]")?.textContent).toContain("The removal stopped before it finished");
  });

  test("a 400: nothing was removed; another refusal is named inside the dialog's own sentence, as text", async () => {
    m = mount([json({ error: "nothing to remove" }, 400), json({ error: "<b>payload</b> too large" }, 413)]);
    m.open();
    await m.press("Remove member");
    expect(m.within("[role=alert]")?.textContent).toBe("Nothing was removed. Reload the page and try again.");
    expect(m.dialog()?.open).toBe(true);
    await m.press("Remove member");
    expect(m.within("[role=alert]")?.textContent).toBe("Nothing was removed. Reload the page and try again. The server refused this request: <b>payload</b> too large");
    expect(m.within("[role=alert] b")).toBeNull();
  });
});
