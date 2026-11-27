import { expect, test } from "vitest";
import { counted } from "./dom.js";
import { newDocument } from "./render.fixture.js";

/** U+00A0 NO-BREAK SPACE, which this runtime's Russian number format writes between thousands. */
const NBSP = " ";

const text = (lang: "en" | "ru", n: number) => counted(newDocument(), lang, "Members", n).map((c) => (typeof c === "string" ? c : c.textContent)).join("");

test("a heading's count reads like the footer beside it: thousands are separated in the language's way", () => {
  expect(text("en", 2000)).toBe("Members 2,000");
  expect(text("ru", 2000)).toBe(`Members 2${NBSP}000`);
});

test("below a thousand nothing changes", () => {
  expect([text("en", 0), text("en", 3), text("ru", 999)]).toEqual(["Members 0", "Members 3", "Members 999"]);
});
