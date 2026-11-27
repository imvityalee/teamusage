import type { Lang } from "../lang.js";
import { placeholder, type LegalSection } from "./section.js";

export type { LegalSection };

/** The terms of service. Every section is the owner's to write before launch. */
const HEADINGS: Record<Lang, string[]> = {
  en: [
    "The service",
    "Free while in beta",
    "Your responsibilities",
    "Acceptable use",
    "Ending a team",
    "Liability",
    "Governing law",
    "Contact",
  ],
  ru: [
    "Сервис",
    "Бесплатно на время беты",
    "Ваши обязанности",
    "Допустимое использование",
    "Прекращение работы команды",
    "Ответственность",
    "Применимое право",
    "Контакты",
  ],
};

export const TERMS: Record<Lang, LegalSection[]> = {
  en: HEADINGS.en.map((heading) => placeholder("en", heading)),
  ru: HEADINGS.ru.map((heading) => placeholder("ru", heading)),
};
