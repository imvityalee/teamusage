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
  k3: "Most used agent",
  perDay: "{n} per day on average",
  apiPrices: "at public API prices",
  ofN: "of {n}",
  share: "{n}% of all tokens",
  chartDaily: "Tokens per day, by agent",
  chartWeekly: "Tokens per week, by agent",
  chartAlt: "Tokens by agent from {from} to {to}: {total} in total.",
  otherAgents: "Other agents",
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
  searchMembers: "Search members",
  matchCount: "{n} of {m} members",
  matchCount1: "{n} of {m} member",
  noMatch: "No members match",
  allMembers: "All members",
  k4: "Active days",
  noMachines: "No machines yet",
  notFound: "Member not found",
  memberTitle: "{name} — teamusage",
  filters: "Filters",
  show: "Show",
  allAgents: "All agents",
  allModels: "All models",
  agentsTitle: "Agents in this period",
  modelsTitle: "Models in this period",
  showAll: "Show all",
  searchModels: "Search models",
  noModels: "No models match",
  nothingInPeriod: "Nothing in this period",
  onlySelectedAgents: "Only models of the selected agents are listed.",
  showingOnly: "Showing only",
  clearFilters: "Clear filters",
  removeFilter: "Remove filter: {name}",
  agentLimit: "You can select up to {n} agents.",
  modelLimit: "You can select up to {n} models.",
  allAccounts: "All accounts",
  accountsTitle: "Accounts in this period",
  accountLimit: "You can select up to {n} accounts.",
  usedSelectedAccounts: "used the selected accounts",
  mhAccounts: "Accounts",
  byAccount: "By account",
  acctTeam: "Team",
  acctEnterprise: "Enterprise",
  acctPersonal: "Personal",
  acctApi: "API key",
  acctUnknown: "Unknown",
  emptyFiltered: "Nothing matches these filters in this period",
  k0f: "Total tokens · filtered",
  k1f: "Estimated cost · filtered",
  ofAllInPeriod: "{n}% of all tokens in this period",
  ofFiltered: "{n}% of filtered tokens",
  ofTheirs: "{n}% of their tokens",
  teamShare: "{n}% of the team's tokens",
  sentUsage: "sent usage in this period",
  usedSelectedAgents: "used the selected agents",
  usedSelectedModels: "used the selected models",
  activeDaysSub: "days with any usage",
  membersHint: "Select a member to see their own usage",
  searchPlaceholder: "Search by name or email",
  mixHead: "Agent mix",
  mixNote: "The bar's length compares each member with the most active member; its colours show which agents they used.",
  mixLabel: "{share}% of the team's tokens: {parts}",
  shareLabel: "{share}% of the team's tokens",
  mixLabelFiltered: "{share}% of the filtered tokens: {parts}",
  shareLabelFiltered: "{share}% of the filtered tokens",
  breadcrumb: "Breadcrumb",
  lastSyncLine: "last sync {when}",
  neverSyncedLine: "never synced",
  syncedToday: "Synced today",
  syncedYesterday: "Synced yesterday",
  neverSynced: "Never synced",
  notCounted: "Usage on this machine since then is not counted yet",
  agents_one: "{n} agent",
  agents_few: "{n} agents",
  agents_many: "{n} agents",
  models_one: "{n} model",
  models_few: "{n} models",
  models_many: "{n} models",
  accounts_one: "{n} account",
  accounts_few: "{n} accounts",
  accounts_many: "{n} accounts",
  machines_one: "{n} machine",
  machines_few: "{n} machines",
  machines_many: "{n} machines",
  daysAgo_one: "{n} day ago",
  daysAgo_few: "{n} days ago",
  daysAgo_many: "{n} days ago",
  syncedDaysAgo_one: "Synced {n} day ago",
  syncedDaysAgo_few: "Synced {n} days ago",
  syncedDaysAgo_many: "Synced {n} days ago",
  noSyncDays_one: "No sync for {n} day",
  noSyncDays_few: "No sync for {n} days",
  noSyncDays_many: "No sync for {n} days",
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
  k3: "Самый используемый агент",
  perDay: "{n} в среднем за день",
  apiPrices: "по публичным ценам API",
  ofN: "из {n}",
  share: "{n}% от всех токенов",
  chartDaily: "Токены по дням, по агентам",
  chartWeekly: "Токены по неделям, по агентам",
  chartAlt: "Токены по агентам с {from} по {to}: всего {total}.",
  otherAgents: "Другие агенты",
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
  searchMembers: "Поиск участников",
  matchCount: "{n} из {m} участников",
  matchCount1: "{n} из {m} участника",
  noMatch: "Участники не найдены",
  allMembers: "Все участники",
  k4: "Активные дни",
  noMachines: "Устройств пока нет",
  notFound: "Участник не найден",
  memberTitle: "{name} — teamusage",
  filters: "Фильтры",
  show: "Показать",
  allAgents: "Все агенты",
  allModels: "Все модели",
  agentsTitle: "Агенты за этот период",
  modelsTitle: "Модели за этот период",
  showAll: "Показать все",
  searchModels: "Поиск моделей",
  noModels: "Модели не найдены",
  nothingInPeriod: "За этот период ничего нет",
  onlySelectedAgents: "Показаны только модели выбранных агентов.",
  showingOnly: "Показаны только",
  clearFilters: "Сбросить фильтры",
  removeFilter: "Убрать фильтр: {name}",
  agentLimit: "Можно выбрать не больше {n} агентов.",
  modelLimit: "Можно выбрать не больше {n} моделей.",
  allAccounts: "Все аккаунты",
  accountsTitle: "Аккаунты за этот период",
  accountLimit: "Можно выбрать не больше {n} аккаунтов.",
  usedSelectedAccounts: "пользовались выбранными аккаунтами",
  mhAccounts: "Аккаунты",
  byAccount: "По аккаунтам",
  acctTeam: "Команда",
  acctEnterprise: "Enterprise",
  acctPersonal: "Личный",
  acctApi: "API-ключ",
  acctUnknown: "Неизвестно",
  emptyFiltered: "За этот период под фильтры ничего не подходит",
  k0f: "Всего токенов · с фильтром",
  k1f: "Оценка стоимости · с фильтром",
  ofAllInPeriod: "{n}% всех токенов за этот период",
  ofFiltered: "{n}% отфильтрованных токенов",
  ofTheirs: "{n}% токенов участника",
  teamShare: "{n}% токенов команды",
  sentUsage: "отправляли данные за этот период",
  usedSelectedAgents: "пользовались выбранными агентами",
  usedSelectedModels: "пользовались выбранными моделями",
  activeDaysSub: "дни, когда были данные",
  membersHint: "Выберите участника, чтобы увидеть его статистику",
  searchPlaceholder: "Поиск по имени или почте",
  mixHead: "Состав по агентам",
  mixNote: "Длина полосы сравнивает участника с самым активным; цвета показывают, какими агентами он пользовался.",
  mixLabel: "{share}% токенов команды: {parts}",
  shareLabel: "{share}% токенов команды",
  mixLabelFiltered: "{share}% отфильтрованных токенов: {parts}",
  shareLabelFiltered: "{share}% отфильтрованных токенов",
  breadcrumb: "Навигация",
  lastSyncLine: "последняя отправка {when}",
  neverSyncedLine: "данные ещё не отправлялись",
  syncedToday: "Отправлено сегодня",
  syncedYesterday: "Отправлено вчера",
  neverSynced: "Ещё не отправлялось",
  notCounted: "Использование на этом устройстве с тех пор ещё не учтено",
  agents_one: "{n} агент",
  agents_few: "{n} агента",
  agents_many: "{n} агентов",
  models_one: "{n} модель",
  models_few: "{n} модели",
  models_many: "{n} моделей",
  accounts_one: "{n} аккаунт",
  accounts_few: "{n} аккаунта",
  accounts_many: "{n} аккаунтов",
  machines_one: "{n} устройство",
  machines_few: "{n} устройства",
  machines_many: "{n} устройств",
  daysAgo_one: "{n} день назад",
  daysAgo_few: "{n} дня назад",
  daysAgo_many: "{n} дней назад",
  syncedDaysAgo_one: "Отправлено {n} день назад",
  syncedDaysAgo_few: "Отправлено {n} дня назад",
  syncedDaysAgo_many: "Отправлено {n} дней назад",
  noSyncDays_one: "Нет отправок {n} день",
  noSyncDays_few: "Нет отправок {n} дня",
  noSyncDays_many: "Нет отправок {n} дней",
};

export const messages: { en: Record<MessageKey, string>; ru: Record<MessageKey, string> } = { en, ru };

/** The message with each `{name}` replaced by its value, literally. The result is text, never markup. */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return messages[lang][key].replace(/\{(\w+)\}/g, (hole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : hole,
  );
}

/** "N of M members", with the noun agreeing with M ("из 21 участника", "of 1 member"). */
export function matchCount(lang: Lang, n: number, m: number): string {
  const one = lang === "ru" ? m % 10 === 1 && m % 100 !== 11 : m === 1;
  return t(lang, one ? "matchCount1" : "matchCount", { n, m });
}

export type PluralForm = "one" | "few" | "many" | "other";

/** The plural category of a count: English one/other; Russian one/few/many, with 11–14 always many. */
export function pluralForm(lang: Lang, n: number): PluralForm {
  const abs = Math.abs(Math.trunc(n));
  if (lang === "en") return abs === 1 ? "one" : "other";
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "many";
  if (last === 1) return "one";
  if (last >= 2 && last <= 4) return "few";
  return "many";
}

export type CountedNoun = "agents" | "models" | "accounts" | "machines" | "daysAgo" | "syncedDaysAgo" | "noSyncDays";

const FORMS = {
  agents: { one: "agents_one", few: "agents_few", many: "agents_many" },
  models: { one: "models_one", few: "models_few", many: "models_many" },
  accounts: { one: "accounts_one", few: "accounts_few", many: "accounts_many" },
  machines: { one: "machines_one", few: "machines_few", many: "machines_many" },
  daysAgo: { one: "daysAgo_one", few: "daysAgo_few", many: "daysAgo_many" },
  syncedDaysAgo: { one: "syncedDaysAgo_one", few: "syncedDaysAgo_few", many: "syncedDaysAgo_many" },
  noSyncDays: { one: "noSyncDays_one", few: "noSyncDays_few", many: "noSyncDays_many" },
} as const satisfies Record<CountedNoun, Record<"one" | "few" | "many", MessageKey>>;

/** "3 агента", "5 models": the number with its noun in the right form. */
export function count(lang: Lang, noun: CountedNoun, n: number): string {
  const form = pluralForm(lang, n);
  return t(lang, FORMS[noun][form === "other" ? "many" : form], { n });
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
