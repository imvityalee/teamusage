/** The rules of the team's settings that the cards share with their tests. */

/** True when `typed`, trimmed, is the team's `name`; both are compared in Unicode form NFC, as the server compares them. */
export const namesMatch = (typed: string, name: string): boolean => typed.trim().normalize("NFC") === name.normalize("NFC");
