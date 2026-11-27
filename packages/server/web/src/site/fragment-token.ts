/** A one-time token that arrives in an address's fragment (`/open`, `/invite`): 64 lowercase hex characters. */
const TOKEN = /^[a-f0-9]{64}$/;

export const isToken = (value: string): boolean => TOKEN.test(value);

/** The token of `#<64 hex>`; null for anything else. */
export function tokenOf(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : "";
  return isToken(value) ? value : null;
}
