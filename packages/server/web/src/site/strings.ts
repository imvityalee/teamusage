import type { Table } from "./i18n.js";

/** The texts of the table pager shared by the dashboard and the team page: one table in English and in Russian. */

const en = {
  pagerLabel: "Table pages",
  pagerRange: "{from}–{to} of {total}",
  pagerRows: "Rows per page",
  pagerPrevious: "Previous",
  pagerNext: "Next",
};

export type PagerKey = keyof typeof en;

const ru: Record<PagerKey, string> = {
  pagerLabel: "Страницы таблицы",
  pagerRange: "{from}–{to} из {total}",
  pagerRows: "Строк на странице",
  pagerPrevious: "Назад",
  pagerNext: "Вперёд",
};

export const strings: Table<PagerKey> = { en, ru };
