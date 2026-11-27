import { test } from "vitest";
import { expectComplete } from "./i18n.fixture.js";
import { strings } from "./strings.js";

test("both tables have the same keys, no empty text and the same placeholders", () => {
  expectComplete(strings);
});
