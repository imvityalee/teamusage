import type { Lang } from "../lang.js";
import type { ApiResult } from "../site/http.js";
import { tt } from "./strings.js";

/**
 * The page's sentence for an answer it cannot go on with: a refusal is named inside the page's own words, drawn as
 * text; the network and a 5xx are "could not be reached"; a 2xx it could not read is said so. A 401 never gets here:
 * it shows the sign-in panel.
 */
export function failureText(lang: Lang, result: ApiResult<unknown>): string {
  switch (result.kind) {
    case "refused":
      return result.error === "" ? tt(lang, "refusedBare") : tt(lang, "refusedText", { error: result.error });
    case "ok":
      return tt(lang, "unreadable");
    default:
      return tt(lang, "failedText");
  }
}
