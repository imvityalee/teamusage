import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { codeHash, isTeamCode, newTeamCode, openCode, sealCode } from "./codes.js";

const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);

/** The sealed text with its bytes passed through `change`, written back in the same format. */
const reseal = (sealed: string, change: (bytes: Buffer) => Buffer) =>
  `v1.${change(Buffer.from(sealed.slice(3), "base64url")).toString("base64url")}`;

test("a new code is 24 lowercase hex characters and two codes differ", () => {
  const [a, b] = [newTeamCode(), newTeamCode()];
  expect(a).toMatch(/^[a-f0-9]{24}$/);
  expect(b).toMatch(/^[a-f0-9]{24}$/);
  expect(a).not.toBe(b);
});

test("isTeamCode accepts exactly the format of a new code", () => {
  expect(isTeamCode(newTeamCode())).toBe(true);
  for (const bad of ["", "a".repeat(23), "a".repeat(25), "A".repeat(24), `${"a".repeat(23)}g`, 42, null, undefined, ["a".repeat(24)]])
    expect(isTeamCode(bad)).toBe(false);
});

test("a sealed code opens with its key", () => {
  const code = newTeamCode();
  expect(openCode(sealCode(code, KEY), KEY)).toBe(code);
});

test("sealing the same code twice gives two different texts", () => {
  const code = newTeamCode();
  expect(sealCode(code, KEY)).not.toBe(sealCode(code, KEY));
});

test("a sealed code does not open with another key", () => {
  expect(openCode(sealCode(newTeamCode(), KEY), OTHER_KEY)).toBeNull();
});

test("a sealed text with one character changed does not open", () => {
  const sealed = sealCode(newTeamCode(), KEY);
  const at = 20;
  const changed = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
  expect(openCode(changed, KEY)).toBeNull();
});

test("a sealed text changed at any one position does not open", () => {
  const sealed = sealCode(newTeamCode(), KEY);
  for (let at = 0; at < sealed.length; at++) {
    const changed = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
    expect(openCode(changed, KEY), `position ${at}`).toBeNull();
  }
});

test("a sealed text whose last character differs only in its unused bits does not open", () => {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const sealed = sealCode(newTeamCode(), KEY);
  const respelled = sealed.slice(0, -1) + ALPHABET[ALPHABET.indexOf(sealed.at(-1)!) ^ 1];
  expect(Buffer.from(respelled.slice(3), "base64url")).toEqual(Buffer.from(sealed.slice(3), "base64url"));
  expect(openCode(respelled, KEY)).toBeNull();
});

test("texts that are not a sealed code do not open", () => {
  for (const text of ["v2.abc", "", "garbage"]) expect(openCode(text, KEY)).toBeNull();
  for (const text of [null, undefined, 42]) expect(openCode(text as unknown as string, KEY)).toBeNull();
});

test("a sealed text under another version prefix, or with characters outside base64url, does not open", () => {
  const sealed = sealCode(newTeamCode(), KEY);
  const body = sealed.slice(3);
  for (const text of [`v2.${body}`, `V1.${body}`, body, `v1.${body}=`, `v1.${body.slice(0, 10)}+${body.slice(11)}`, `v1. ${body}`])
    expect(openCode(text, KEY)).toBeNull();
});

test("a sealed text with a shortened tag does not open", () => {
  const sealed = sealCode(newTeamCode(), KEY);
  for (const cut of [1, 4, 12, 16]) expect(openCode(reseal(sealed, (b) => b.subarray(0, b.length - cut)), KEY)).toBeNull();
});

test("a sealed text too short to hold an iv and a tag does not open", () => {
  const sealed = sealCode(newTeamCode(), KEY);
  for (const keep of [0, 11, 12, 27, 28]) expect(openCode(reseal(sealed, (b) => b.subarray(0, keep)), KEY)).toBeNull();
});

test("a sealed text with its iv shortened or lengthened does not open", () => {
  const sealed = sealCode(newTeamCode(), KEY);
  expect(openCode(reseal(sealed, (b) => b.subarray(1)), KEY)).toBeNull();
  expect(openCode(reseal(sealed, (b) => Buffer.concat([Buffer.alloc(1), b])), KEY)).toBeNull();
});

test("a sealed text is v1. and base64url of a 12-byte iv, the ciphertext and a 16-byte tag", () => {
  const sealed = sealCode("a".repeat(24), KEY);
  expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
  expect(Buffer.from(sealed.slice(3), "base64url").length).toBe(12 + 24 + 16);
});

test("sealing and opening refuse a key that is not 32 bytes and never name the key", () => {
  const sealed = sealCode(newTeamCode(), KEY);
  const shortKey = Buffer.from("secret-key-material-0123456789");
  for (const act of [() => sealCode(newTeamCode(), shortKey), () => openCode(sealed, shortKey)]) {
    let caught: unknown;
    try { act(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).not.toContain("secret-key-material");
    expect(String((caught as Error).message)).not.toContain(shortKey.toString("hex"));
  }
});

test("codeHash is the SHA-256 hex of the code", () => {
  const code = newTeamCode();
  expect(codeHash(code)).toBe(createHash("sha256").update(code).digest("hex"));
});
