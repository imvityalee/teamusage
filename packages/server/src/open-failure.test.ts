import { expect, test } from "vitest";
import { NewerSchemaError, UpgradeFailedError } from "./migrate.js";
import { HostedDatabaseError, openFailureMessage } from "./open-failure.js";

test("a newer database gets its own start message", () => {
  expect(openFailureMessage(new NewerSchemaError())).toBe("teamusage: this database was written by a newer teamusage; upgrade the server");
  expect(openFailureMessage(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("teamusage: could not open the data directory or database (EACCES)");
});
test("a failed upgrade step gets its own line, without the cause's message", () => {
  const cause = Object.assign(new Error("boom /private/path"), { code: "SQLITE_FULL" });
  const line = openFailureMessage(new UpgradeFailedError(2, cause));
  expect(line).toBe("teamusage: upgrade step 2 of the database failed and was rolled back (SQLITE_FULL)");
});
test("a hosted server's database refused by a self-hosted start gets its own line", () => {
  expect(openFailureMessage(new HostedDatabaseError())).toBe("teamusage: this database belongs to a hosted server; set TEAMUSAGE_MODE=hosted");
});
