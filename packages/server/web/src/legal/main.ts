import type { Lang } from "../lang.js";
import { h } from "../dom.js";
import { applyText, languageSwitch } from "../site/i18n.js";
import { PRIVACY } from "./privacy.js";
import type { LegalSection } from "./section.js";
import { LEGAL_TEXT_IS_PLACEHOLDER, strings, type LegalKey } from "./strings.js";
import { TERMS } from "./terms.js";

/** `/privacy` and `/terms`: the draft banner while the text is a placeholder, and the page's sections in the chosen language. */

const PAGES: Record<"privacy" | "terms", { sections: Record<Lang, LegalSection[]>; docTitle: LegalKey }> = {
  privacy: { sections: PRIVACY, docTitle: "privacyDocTitle" },
  terms: { sections: TERMS, docTitle: "termsDocTitle" },
};
const page = PAGES[document.body.dataset.legal === "terms" ? "terms" : "privacy"];
const banner = document.getElementById("banner") as HTMLElement;
const container = document.getElementById("sections") as HTMLElement;

function drawSection({ heading, paragraphs, placeholder }: LegalSection): HTMLElement {
  return h(
    document,
    "section",
    placeholder ? { class: "legal-section placeholder" } : { class: "legal-section" },
    h(document, "h2", {}, heading),
    ...paragraphs.map((text) => h(document, "p", {}, text)),
  );
}

function paint(lang: Lang): void {
  applyText(document, strings, lang, page.docTitle);
  banner.hidden = !LEGAL_TEXT_IS_PLACEHOLDER;
  container.replaceChildren(...page.sections[lang].map(drawSection));
}

paint(languageSwitch(document, paint));
