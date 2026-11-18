import { expect, test } from "vitest";
import { machineId, machineLabel, readOsId } from "./machine.js";

const OS_ID = "0123456789abcdef0123456789abcdef";

test("stable for the same os id and email, case-insensitive on email", () => {
  const a = machineId("Ann@Example.com", OS_ID);
  expect(machineId("ann@example.com", OS_ID)).toBe(a);
  expect(machineId(" ANN@EXAMPLE.COM ", OS_ID)).toBe(a);
});

test("differs between members on one machine", () => {
  expect(machineId("ann@example.com", OS_ID)).not.toBe(machineId("bob@example.com", OS_ID));
});

test("differs between machines for one member", () => {
  expect(machineId("ann@example.com", OS_ID)).not.toBe(machineId("ann@example.com", "another-os-id"));
});

test("32 hex chars and does not contain the os id", () => {
  const id = machineId("ann@example.com", OS_ID);
  expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(id).not.toContain(OS_ID);
  expect(id).not.toContain(OS_ID.slice(0, 8));
});

test("refuses to derive an id without an os id", () => {
  expect(() => machineId("ann@example.com", null)).toThrow();
});

test("readOsId returns a non-empty string or null and never throws", () => {
  const id = readOsId();
  if (id !== null) expect(id.length).toBeGreaterThan(0);
});

test("machineLabel is 1 to 100 characters", () => {
  const label = machineLabel();
  expect(label.length).toBeGreaterThan(0);
  expect(label.length).toBeLessThanOrEqual(100);
});
