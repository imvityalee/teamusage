import type { Lang } from "../lang.js";
import { translator, type Table } from "../site/i18n.js";

/** What the dashboard gains on a hosted server: its header, its panels and its new messages, in English (also in index.html) and Russian. */

const en = {
  teamTitle: "teamusage — {team}",
  navLabel: "Team",
  navDashboard: "Dashboard",
  navTeam: "Team",
  sample: "Sample data",
  createTeam: "Create a team",
  fromAgent: "Signed in from your agent",
  yourTeams: "Your teams",
  signOut: "Sign out",
  signOutFailed: "Could not sign out. Try again.",
  signedOutTitle: "Sign in to see this dashboard",
  memberPrompt: "Team member?",
  openFromAgent: "Open it from your coding agent.",
  signInGithub: "Sign in with GitHub",
  noTeam: "This team was not found, or you no longer have a role in it.",
  busy: "This team's statistics are busy. Trying again in {n} s.",
  stillBusy: "This team's statistics are still busy. Try again in a minute.",
  wrongAddress: "This server accepts sign-in only from its own address. Ask whoever runs it to check TEAMUSAGE_PUBLIC_URL.",
};

export type DashKey = keyof typeof en;

const ru: Record<DashKey, string> = {
  teamTitle: "teamusage — {team}",
  navLabel: "Команда",
  navDashboard: "Дашборд",
  navTeam: "Команда",
  sample: "Пример данных",
  createTeam: "Создать команду",
  fromAgent: "Вы вошли из своего агента",
  yourTeams: "Ваши команды",
  signOut: "Выйти",
  signOutFailed: "Не удалось выйти. Попробуйте ещё раз.",
  signedOutTitle: "Войдите, чтобы открыть этот дашборд",
  memberPrompt: "Вы участник команды?",
  openFromAgent: "Откройте его из своего агента.",
  signInGithub: "Войти через GitHub",
  noTeam: "Команда не найдена, или у вас больше нет роли в ней.",
  busy: "Статистика команды сейчас занята. Повторим через {n} с.",
  stillBusy: "Статистика команды всё ещё занята. Попробуйте ещё раз через минуту.",
  wrongAddress: "Этот сервер принимает вход только со своего адреса. Попросите того, кто его запускает, проверить TEAMUSAGE_PUBLIC_URL.",
};

export const strings: Table<DashKey> = { en, ru };

export const dt = translator(strings);

const isKey = (k: string | null): k is DashKey => k !== null && Object.hasOwn(en, k);

/** Fills every `data-dash` element's text and every `data-dash-label` element's aria-label from the table. */
export function applyDashText(doc: Document, lang: Lang): void {
  for (const el of doc.querySelectorAll("[data-dash]")) {
    const key = el.getAttribute("data-dash");
    if (isKey(key)) el.textContent = dt(lang, key);
  }
  for (const el of doc.querySelectorAll("[data-dash-label]")) {
    const key = el.getAttribute("data-dash-label");
    if (isKey(key)) el.setAttribute("aria-label", dt(lang, key));
  }
}
