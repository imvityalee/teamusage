import type { Lang } from "../lang.js";
import type { TeamInfo } from "./api.js";

/**
 * What a card of the team page is given and what it gives back. `main.ts` builds each card once the team is read and
 * puts its element in `#cards`; a new card is a module that takes a `TeamContext` and returns a `Card`.
 */

export type TeamContext = {
  doc: Document;
  lang(): Lang;
  /** The team as the server last named it. */
  team(): TeamInfo;
  /** The server's answer to a change of the team: the page keeps it and draws every card again. */
  update(team: TeamInfo): void;
  /** A 401: the page shows its sign-in panel. A card closes its dialog first. */
  signedOut(): void;
  /** Asks the server again for the session and the team, and draws the page and every card anew from the answer. */
  reload(): Promise<void>;
  /** Leaves for another page, which Back does not return from (after the team was deleted). */
  go(path: string): void;
};

/** A card: its element, and `paint` to draw it again in the page's language or after the team changed. */
export type Card = { element: HTMLElement; paint(): void };
