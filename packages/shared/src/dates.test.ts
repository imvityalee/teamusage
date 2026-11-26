import { expect, test } from "vitest";
import { addDays, checkRange, datesBetween, isIsoDate, isUsageDate, latestUsageDate, localIsoDate, parseIsoDate } from "./dates.js";

test("parseIsoDate accepts only strict, real calendar dates", () => {
  expect(parseIsoDate("2026-11-18")).toBe(Date.UTC(2026, 10, 18));
  expect(parseIsoDate("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
  for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-01", " 2026-01-01", "2026-01-01T00:00:00Z", ""]) {
    expect(parseIsoDate(bad)).toBeUndefined();
  }
  expect(isIsoDate(20261118)).toBe(false);
});

test("addDays crosses months, years and leap days in either direction", () => {
  expect(addDays("2026-11-18", -2)).toBe("2026-11-16");
  expect(addDays("2026-03-01", -2)).toBe("2026-02-27");
  expect(addDays("2027-01-01", -2)).toBe("2026-12-30");
  expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
});

test("localIsoDate uses the local calendar day", () => {
  expect(localIsoDate(new Date(2026, 10, 18, 23, 59))).toBe("2026-11-18");
  expect(localIsoDate(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
});

test("checkRange accepts ordered real dates up to 730 days", () => {
  expect(checkRange("2026-01-01", "2026-01-01")).toBe("ok");
  expect(checkRange("2024-11-19", "2026-11-18")).toBe("ok"); // 730 days inclusive
});

test("checkRange rejects missing, unreal, reversed and too long ranges", () => {
  expect(checkRange("", "2026-01-01")).toBe("invalid");
  expect(checkRange("2026-02-30", "2026-03-01")).toBe("invalid");
  expect(checkRange("2026-02-01", "2026-01-01")).toBe("order");
  expect(checkRange("2024-11-18", "2026-11-18")).toBe("tooLong"); // 731 days
});

test("years 0000 to 0099 are themselves, not 1900 to 1999", () => {
  expect(isIsoDate("0050-01-01")).toBe(true);
  expect(addDays("0050-01-01", 1)).toBe("0050-01-02");
  expect(addDays("0000-03-01", -1)).toBe("0000-02-29");
});

test("datesBetween lists every day, including the last one a date can have", () => {
  expect(datesBetween("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  expect(datesBetween("9999-12-30", "9999-12-31")).toEqual(["9999-12-30", "9999-12-31"]);
  expect(datesBetween("2026-01-02", "2026-01-01")).toEqual([]);
  expect(() => datesBetween("2026-02-30", "2026-03-01")).toThrow(RangeError);
});

test("latestUsageDate is tomorrow in UTC", () => {
  expect(latestUsageDate(new Date("2026-12-31T12:00:00Z"))).toBe("2027-01-01");
  expect(latestUsageDate(new Date("2028-02-28T00:00:00Z"))).toBe("2028-02-29");
});

test("isUsageDate refuses a day that is not on the calendar", () =>
  expect(isUsageDate("2026-02-31", new Date("2026-11-25T10:30:00Z"))).toBe(false));
