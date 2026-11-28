import { afterEach, describe, expect, test } from "vitest";
import { json } from "../site/page.fixture.js";
import { team } from "./members.fixture.js";
import { membersReply, mountMembers, type MountedMembers } from "./members-card.fixture.js";

let m: MountedMembers;
afterEach(async () => m?.world.close());

const alert = () => m.$("#members-error");
const retry = () => m.$<HTMLButtonElement>("#members-retry");
const shown = (el: HTMLElement) => !el.hidden;

describe("what the card does with the server's answers", () => {
  test("while the list is on its way the card says so, and shows no table", async () => {
    m = await mountMembers("pending");
    expect(m.$(".card-note").textContent).toBe("Loading the members…");
    expect(m.all("table")).toHaveLength(0);
    expect(m.$(".search").hidden).toBe(true);
  });

  test("a 401 is the page's: the sign-in panel, no alert in the card", async () => {
    m = await mountMembers(json({ error: "unauthorized" }, 401));
    expect(m.world.ctx.signedOut).toHaveBeenCalledTimes(1);
    expect(shown(alert())).toBe(false);
  });

  test.each([403, 404])("a %i of the list is a role lost while the page is open: the page reads its session and team again, with no alert", async (status) => {
    m = await mountMembers(json({ error: "forbidden" }, status));
    expect(m.world.ctx.reload).toHaveBeenCalledTimes(1);
    expect(shown(alert())).toBe(false);
    expect(shown(retry())).toBe(false);
  });

  test("a 5xx is the card's own alert with Try again, and a second press reads the list", async () => {
    m = await mountMembers(json({ error: "boom" }, 500), [membersReply(team(30))]);
    expect(alert().textContent).toBe("Could not load the members. The server could not be reached.");
    expect(alert().getAttribute("role")).toBe("alert");
    expect(alert().tagName).toBe("P");
    expect(shown(retry())).toBe(true);
    expect(m.world.ctx.reload).not.toHaveBeenCalled();
    retry().click();
    await m.world.flush();
    expect([shown(alert()), shown(retry()), m.all("tbody tr[data-member-id]").length]).toEqual([false, false, 25]);
  });

  test("the network failing is the same alert", async () => {
    m = await mountMembers(new Error("offline"));
    expect(alert().textContent).toBe("Could not load the members. The server could not be reached.");
  });

  test("an unknown refusal is shown inside the card's own sentence, the server's text drawn as text", async () => {
    m = await mountMembers(json({ error: "<img src=x onerror=alert(1)>" }, 400));
    expect(alert().textContent).toBe("Could not load the members. The server refused this request: <img src=x onerror=alert(1)>");
    expect(alert().querySelector("img")).toBeNull();
  });

  test("an answer that is not a list of members is told as unreadable", async () => {
    m = await mountMembers(json({ members: [{ id: "x" }] }));
    expect(alert().textContent).toBe("Could not load the members. The server's answer could not be read.");
  });

  test("Try again is disabled while its request is out, and a double press sends one request", async () => {
    let answer: (r: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => (answer = resolve));
    m = await mountMembers(json({ error: "boom" }, 500), [slow]);
    retry().focus();
    retry().click();
    expect(retry().disabled).toBe(true);
    retry().click();
    expect(m.world.calls).toHaveLength(2);
    answer(json({ error: "boom" }, 500));
    await m.world.flush();
    expect(retry().disabled).toBe(false);
    expect(m.focused()).toBe(retry());
  });

  test("a failed reading after a good one keeps the list and says so", async () => {
    m = await mountMembers(team(30), [json({ error: "boom" }, 500)]);
    await m.card.reload();
    expect(shown(alert())).toBe(true);
    expect(m.all("tbody tr[data-member-id]")).toHaveLength(25);
  });

  test("an answer that is not the latest reading is dropped", async () => {
    let first: (r: Response) => void = () => {};
    const late = new Promise<Response>((resolve) => (first = resolve));
    m = await mountMembers(late, [membersReply(team(3))]);
    void m.card.reload();
    await m.world.flush();
    first(membersReply(team(30)));
    await m.world.flush();
    expect(m.all("tbody tr[data-member-id]")).toHaveLength(3);
  });

  test("Russian: the card's own sentences", async () => {
    m = await mountMembers(json({ error: "boom" }, 500), [], { lang: "ru" });
    expect(alert().textContent).toBe("Не удалось загрузить участников. Не удалось связаться с сервером.");
    expect(retry().textContent).toBe("Повторить");
  });
});
