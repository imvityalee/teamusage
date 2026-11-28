import { afterEach, expect, test } from "vitest";
import { expectNowhereIn } from "./page.fixture.js";
import { mount, NEW_CODE, ONE_MACHINE, ONE_MEMBER, removed, type Mounted } from "./removal-dialog.fixture.js";

/** Board 12: the new code, shown once inside the dialog and kept nowhere else. */

let m: Mounted;
afterEach(async () => m?.world.close());

async function showCode(o: Parameters<typeof mount>[1] = {}, target = ONE_MEMBER, confirm = "Remove member") {
  m = mount([removed(1, 1, NEW_CODE)], o);
  m.open(target);
  await m.press(confirm);
}

test("the dialog becomes board 12: Removed, the new code in its box, Copy code and Done, with Copy code focused", async () => {
  await showCode();
  expect(m.within("h2")?.textContent).toBe("The team has a new code");
  expect(m.within(".badge")?.textContent).toBe("Removed");
  expect(m.text()).toContain("Nurlan Asanov was removed. The old code no longer lets anyone join. Everyone who already joined keeps working and needs nothing.");
  expect(m.within(".code")?.textContent).toBe(NEW_CODE);
  expect(m.within(".code")?.getAttribute("aria-label")).toBe("New team code");
  expect(m.text()).toContain("Send it only to people who join from now on. You can show it again on the team page.");
  expect(m.button("Copy code")).not.toBeNull();
  expect(m.button("Done")).not.toBeNull();
  expect(m.box()).toBeNull();
  expect(m.world.doc.activeElement).toBe(m.button("Copy code"));
});

test("a machine's board 12 names the machine; Russian has its own words", async () => {
  await showCode({}, ONE_MACHINE, "Remove machine");
  expect(m.text()).toContain("The machine nurlan-laptop was removed.");
  await m.world.close();
  await showCode({ lang: "ru" }, ONE_MEMBER, "Удалить участника");
  expect(m.within("h2")?.textContent).toBe("У команды новый код");
  expect(m.text()).toContain("Участника Nurlan Asanov больше нет в команде.");
  expect(m.button("Скопировать код")).not.toBeNull();
});

test("Copy code copies the code inside the press, and says it did", async () => {
  await showCode();
  m.button("Copy code")!.click();
  expect(m.world.writeText).toHaveBeenCalledWith(NEW_CODE);
  await m.world.flush();
  expect(m.world.held()).toBe(NEW_CODE);
  expect(m.button("Copied")).not.toBeNull();
});

test("a clipboard that refuses: the dialog says to copy it by hand", async () => {
  await showCode({ refuseClipboard: true });
  await m.press("Copy code");
  expect(m.within("[role=alert]")?.textContent).toBe("Could not copy. Select the code and copy it yourself.");
  expect(m.within(".code")?.textContent).toBe(NEW_CODE);
});

test("while the code shows, Escape and the backdrop do not close the dialog; only Done does, and focus goes to the card's heading", async () => {
  await showCode();
  m.escape();
  m.backdrop();
  await m.world.flush();
  expect(m.dialog()?.open).toBe(true);
  expect(m.within(".code")?.textContent).toBe(NEW_CODE);
  m.opener.remove();
  await m.press("Done");
  expect(m.dialog()).toBeNull();
  expect(m.world.doc.activeElement).toBe(m.refocus);
});

test("the code is in no attribute, title, address or storage while it shows, and out of the document at once when Done is pressed", async () => {
  await showCode();
  expectNowhereIn(m.world, NEW_CODE, true);
  const dialog = m.dialog() as HTMLDialogElement;
  // A browser runs a closing motion: the dialog stays attached until it finishes. This one never does.
  dialog.getAnimations = (() => [{ finished: new Promise(() => {}) }]) as unknown as typeof dialog.getAnimations;
  await m.press("Done");
  expect(dialog.isConnected).toBe(true);
  expect(dialog.textContent).not.toContain(NEW_CODE);
  expectNowhereIn(m.world, NEW_CODE);
});

test("a later dialog starts from board 11 and shows no code", async () => {
  await showCode();
  await m.press("Done");
  m.open(ONE_MEMBER);
  expect(m.within(".code")).toBeNull();
  expect(m.box().checked).toBe(true);
  expectNowhereIn(m.world, NEW_CODE);
});
