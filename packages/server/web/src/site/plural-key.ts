import type { Lang } from "../lang.js";
import { pluralForm } from "../plural.js";

export type PluralKey<P extends string> = `${P}_one` | `${P}_few` | `${P}_many`;

/** The string key of a counted noun for `n`: `<prefix>_one`, `_few` or `_many` (English has no `_few` form of its own). */
export function pluralKey<P extends string>(lang: Lang, prefix: P, n: number): PluralKey<P> {
  const form = pluralForm(lang, n);
  return `${prefix}_${form === "other" ? "many" : form}` as PluralKey<P>;
}
