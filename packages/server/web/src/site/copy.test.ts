import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { copyWith } from "./copy.js";

let win: Window;
let button: HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  win = new Window();
  button = (win.document as unknown as Document).createElement("button");
  button.textContent = "Copy code";
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await win.happyDOM.close();
});

const clipboard = (writeText: (text: string) => Promise<void>) => vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(writeText) } });

test("copies the text and shows the done text for two seconds, then the button's own label again", async () => {
  clipboard(async () => {});
  expect(await copyWith(button, "the text", "Copied")).toBe(true);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("the text");
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(1);
  expect(button.textContent).toBe("Copy code");
});

test("a second copy inside the two seconds keeps the label, and the two seconds start again", async () => {
  clipboard(async () => {});
  await copyWith(button, "a", "Copied");
  await vi.advanceTimersByTimeAsync(1_500);
  await copyWith(button, "b", "Copied");
  await vi.advanceTimersByTimeAsync(1_500);
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(500);
  expect(button.textContent).toBe("Copy code");
});

test("a label drawn again meanwhile (another language) is left as it is", async () => {
  clipboard(async () => {});
  await copyWith(button, "a", "Copied");
  button.textContent = "Скопировать код";
  await vi.advanceTimersByTimeAsync(2_000);
  expect(button.textContent).toBe("Скопировать код");
});

test("returns false when the browser refuses, and the label stays", async () => {
  clipboard(async () => {
    throw new Error("NotAllowedError");
  });
  expect(await copyWith(button, "the text", "Copied")).toBe(false);
  expect(button.textContent).toBe("Copy code");
});

test("returns false when the browser has no clipboard", async () => {
  vi.stubGlobal("navigator", {});
  expect(await copyWith(button, "the text", "Copied")).toBe(false);
  expect(button.textContent).toBe("Copy code");
});
