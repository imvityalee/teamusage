import type { Table } from "../site/i18n.js";

/** True until the owner's legal text replaces the placeholders; while true both pages show the banner. Plan 6 refuses to launch with it true. */
export const LEGAL_TEXT_IS_PLACEHOLDER = true;

/** What the privacy and terms pages say besides their sections, in English (also written in the HTML) and Russian. */

const en = {
  privacyDocTitle: "Privacy · teamusage",
  termsDocTitle: "Terms · teamusage",
  language: "Language",
  navLegal: "Legal",
  banner: "Draft. The legal text on this page is a placeholder. It is replaced before launch.",
  privacyHeading: "Privacy policy",
  termsHeading: "Terms of service",
  footerPrivacy: "Privacy",
  footerTerms: "Terms",
};

export type LegalKey = keyof typeof en;

const ru: Record<LegalKey, string> = {
  privacyDocTitle: "Конфиденциальность · teamusage",
  termsDocTitle: "Условия · teamusage",
  language: "Язык",
  navLegal: "Правовая информация",
  banner: "Черновик. Юридический текст на этой странице — заглушка. Его заменят до запуска.",
  privacyHeading: "Политика конфиденциальности",
  termsHeading: "Условия использования",
  footerPrivacy: "Конфиденциальность",
  footerTerms: "Условия",
};

export const strings: Table<LegalKey> = { en, ru };
