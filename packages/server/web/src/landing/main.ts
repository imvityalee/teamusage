import type { Lang } from "../i18n.js";
import { applyText, languageSwitch } from "../site/i18n.js";
import { strings } from "./strings.js";

/** `/`: the landing page is static; this only puts the chosen language on it. It makes no request. */

function paint(lang: Lang): void {
  applyText(document, strings, lang, "title");
}

paint(languageSwitch(document, paint));
