import type { Lang } from "../lang.js";

/** One part of a legal page: a heading and its paragraphs. A placeholder is a part the service's owner has yet to write. */
export type LegalSection = { heading: string; paragraphs: string[]; placeholder: boolean };

const MARK: Record<Lang, string> = { en: "[Placeholder]", ru: "[Заглушка]" };
const PLACEHOLDER_PARAGRAPH: Record<Lang, string> = {
  en: "This section is supplied by the service's owner before launch.",
  ru: "Этот раздел владелец сервиса добавит до запуска.",
};

/** A section of facts that hold true of the product as it is. */
export function facts(heading: string, ...paragraphs: string[]): LegalSection {
  return { heading, paragraphs, placeholder: false };
}

/** A section the owner supplies before launch: the heading marked, and the one standard paragraph. */
export function placeholder(lang: Lang, heading: string): LegalSection {
  return { heading: `${MARK[lang]} ${heading}`, paragraphs: [PLACEHOLDER_PARAGRAPH[lang]], placeholder: true };
}
