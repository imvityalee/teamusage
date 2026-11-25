import { expect, test } from "vitest";
import { NewerSchemaError } from "./migrate.js";
import { openFailureMessage } from "./open-failure.js";

test("a newer database gets its own start message", () => {
  expect(openFailureMessage(new NewerSchemaError())).toBe("teamusage: this database was written by a newer teamusage; upgrade the server");
  expect(openFailureMessage(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("teamusage: could not open the data directory or database (EACCES)");
});
