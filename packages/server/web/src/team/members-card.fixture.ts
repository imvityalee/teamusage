import { vi } from "vitest";
import type { Lang } from "../lang.js";
import { json, type Reply } from "../site/page.fixture.js";
import type { ApiMember } from "./api.js";
import { cardWorld, type World } from "./card.fixture.js";
import { membersCard, type MembersCard, type Removal } from "./members-card.js";
import { TODAY } from "./members.fixture.js";
import { teamInfo } from "./page.fixture.js";

/** The members card on its own, in happy-dom, for the card's tests (tests only). Dates are drawn in UTC. */

export type MountedMembers = {
  world: World;
  card: MembersCard;
  onRemove: ReturnType<typeof vi.fn<(what: Removal, opener: HTMLElement) => void>>;
  $: <E extends HTMLElement = HTMLElement>(sel: string) => E;
  all: <E extends HTMLElement = HTMLElement>(sel: string) => E[];
  /** The names drawn in the table, in order. */
  names: () => string[];
  /** Types into the search box as a person does. */
  type(value: string): void;
  click(sel: string): void;
  focused: () => Element | null;
};

export const membersReply = (members: ApiMember[]) => json({ members });

/** Draws the card for an admin of a team and lets its request run; `replies` answer the requests in order. */
export async function mountMembers(members: ApiMember[] | Reply, more: Parameters<typeof cardWorld>[1] = [], o: { lang?: Lang } = {}): Promise<MountedMembers> {
  const first = Array.isArray(members) ? membersReply(members) : members;
  const world = cardWorld(teamInfo("admin"), [first, ...more], o);
  const onRemove = vi.fn<(what: Removal, opener: HTMLElement) => void>();
  const card = membersCard(world.ctx, { today: () => TODAY, timeZone: "UTC", onRemove });
  world.doc.body.append(card.element, card.summary);
  await world.flush();
  const $ = <E extends HTMLElement = HTMLElement>(sel: string) => world.doc.querySelector(sel) as E;
  return {
    world,
    card,
    onRemove,
    $,
    all: <E extends HTMLElement = HTMLElement>(sel: string) => [...world.doc.querySelectorAll<E>(sel)],
    names: () => [...world.doc.querySelectorAll(".member-name")].map((el) => el.textContent ?? ""),
    type(value) {
      const input = $<HTMLInputElement>("#member-search");
      input.value = value;
      input.dispatchEvent(new world.win.Event("input", { bubbles: true }) as unknown as Event);
    },
    click: (sel) => $(sel).click(),
    focused: () => world.doc.activeElement,
  };
}
