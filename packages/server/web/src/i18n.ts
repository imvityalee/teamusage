/** UI strings in English and Russian, and the stored language choice. */

export type Lang = "en" | "ru";

const en = {
  title: "teamusage — team usage",
  period: "Period",
  language: "Language",
  r30: "1 month",
  r90: "3 months",
  r180: "6 months",
  from: "From",
  to: "To",
  rangeOrder: "The start date is after the end date.",
  rangeTooLong: "A range can be at most 730 days.",
  k0: "Total tokens",
  k1: "Estimated cost",
  k2: "Active members",
  k3: "Top agent",
  perDay: "{n} per day on average",
  apiPrices: "at public API prices",
  ofN: "of {n}",
  share: "{n}% of all tokens",
  chartDaily: "Tokens per day, by agent",
  chartWeekly: "Tokens per week, by agent",
  chartAlt: "Tokens by agent from {from} to {to}: {total} in total.",
  others: "Others",
  members: "Members",
  models: "Agents and models",
  mh0: "Member",
  mh1: "Total tokens",
  mh2: "Cost (USD)",
  mh3: "Share",
  mh4: "Machines",
  mh5: "Last sync",
  oh0: "Agent",
  oh1: "Model",
  oh2: "Input",
  oh3: "Output",
  oh4: "Cache create",
  oh5: "Cache read",
  oh6: "Total tokens",
  oh7: "Cost (USD)",
  unpriced: "no price",
  unpricedHint: "No public price is known for this model, so its cost is not included.",
  today: "today",
  yesterday: "yesterday",
  daysAgo: "{n} days ago",
  empty: "No usage in this period",
  note: "Cost is an estimate from public API prices, not what subscription plans actually charge. No project names, prompts or file paths are collected.",
  loginTitle: "Sign in",
  loginText: "Enter the team invite code to see the dashboard.",
  inviteLabel: "Invite code",
  signIn: "Sign in",
  loginWrong: "Wrong invite code.",
  loginTooMany: "Too many attempts. Try again in {n} minutes.",
  loginTooMany1: "Too many attempts. Try again in 1 minute.",
  loginFailed: "Could not sign in. Try again.",
  loading: "Loading…",
  netError: "Could not reach the server.",
  loadFailed: "Could not load the statistics: {error}",
  retry: "Retry",
};

export type MessageKey = keyof typeof en;

const ru: Record<MessageKey, string> = {
  title: "teamusage — статистика команды",
  period: "Период",
  language: "Язык",
  r30: "1 месяц",
  r90: "3 месяца",
  r180: "6 месяцев",
  from: "С",
  to: "По",
  rangeOrder: "Дата начала позже даты окончания.",
  rangeTooLong: "Период не может быть длиннее 730 дней.",
  k0: "Всего токенов",
  k1: "Оценка стоимости",
  k2: "Активные участники",
  k3: "Главный агент",
  perDay: "{n} в среднем за день",
  apiPrices: "по публичным ценам API",
  ofN: "из {n}",
  share: "{n}% от всех токенов",
  chartDaily: "Токены по дням, по агентам",
  chartWeekly: "Токены по неделям, по агентам",
  chartAlt: "Токены по агентам с {from} по {to}: всего {total}.",
  others: "Другие",
  members: "Участники",
  models: "Агенты и модели",
  mh0: "Участник",
  mh1: "Всего токенов",
  mh2: "Стоимость (USD)",
  mh3: "Доля",
  mh4: "Устройства",
  mh5: "Последняя отправка",
  oh0: "Агент",
  oh1: "Модель",
  oh2: "Input",
  oh3: "Output",
  oh4: "Cache create",
  oh5: "Cache read",
  oh6: "Всего токенов",
  oh7: "Стоимость (USD)",
  unpriced: "нет цены",
  unpricedHint: "Публичная цена этой модели неизвестна, поэтому её стоимость не учтена.",
  today: "сегодня",
  yesterday: "вчера",
  daysAgo: "{n} дн. назад",
  empty: "За этот период данных нет",
  note: "Стоимость — оценка по публичным ценам API, а не реальные списания по подписке. Названия проектов, промпты и пути к файлам не собираются.",
  loginTitle: "Вход",
  loginText: "Введите инвайт-код команды, чтобы открыть статистику.",
  inviteLabel: "Инвайт-код",
  signIn: "Войти",
  loginWrong: "Неверный инвайт-код.",
  loginTooMany: "Слишком много попыток. Попробуйте снова через {n} мин.",
  loginTooMany1: "Слишком много попыток. Попробуйте снова через 1 мин.",
  loginFailed: "Не удалось войти. Попробуйте ещё раз.",
  loading: "Загрузка…",
  netError: "Не удалось связаться с сервером.",
  loadFailed: "Не удалось загрузить статистику: {error}",
  retry: "Повторить",
};

export const messages: { en: Record<MessageKey, string>; ru: Record<MessageKey, string> } = { en, ru };

/** The message with each `{name}` replaced by its value, literally. The result is text, never markup. */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return messages[lang][key].replace(/\{(\w+)\}/g, (hole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : hole,
  );
}

/** A stored choice wins; otherwise Russian for a Russian browser, English for everything else. */
export function pickLang(stored: string | null, navigatorLang: string): Lang {
  if (stored === "en" || stored === "ru") return stored;
  return navigatorLang.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export const LANG_KEY = "teamusage.lang";

/** The stored language, or null when there is none or storage is blocked. */
export function loadLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

/** Remembers the language. The only thing this page ever stores. */
export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Storage blocked or full: the choice simply lasts for this visit.
  }
}

export function locale(lang: Lang): string {
  return lang === "ru" ? "ru-RU" : "en-US";
}
