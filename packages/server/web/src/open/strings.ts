import type { Table } from "../site/i18n.js";

/** Everything `/open` says, in English (also written in open.html) and Russian. */

const en = {
  title: "Open the dashboard · teamusage",
  language: "Language",
  howTitle: "Open the dashboard from your coding agent",
  howIntro: "Your own machine asks for a one-time link and opens it here. There is no code to type and no account to create.",
  askAgent: "Ask your agent, in Claude Code or Codex",
  agentPhrase: "open the team dashboard",
  orTerminal: "Or run in a terminal",
  howNote: "The link works once and for 5 minutes. This browser then stays signed in for 30 days. Needs teamusage 0.4.0 or newer.",
  adminsNote: "Some teams limit the dashboard to their admins. Your own numbers are always available in your agent.",
  ownerPrompt: "Owner, admin or viewer?",
  signInGithub: "Sign in with GitHub",
  signInCode: "Sign in with the invite code",
  opening: "Opening your team's dashboard…",
  confirmTitle: "Open the dashboard as a team member?",
  signedInGithub: "This browser is signed in with GitHub",
  confirmText:
    "A browser holds one sign-in. Opening this link replaces the GitHub one: you will see the dashboard as a member, and the team page will ask you to sign in with GitHub again.",
  openAsMember: "Open as a member",
  stayGithub: "Stay signed in with GitHub",
  confirmNote: "The link works once and stops working 5 minutes after your agent made it.",
  expiredBadge: "Link not opened",
  expiredTitle: "This link no longer works",
  expiredText: "A link opens the dashboard once, within 5 minutes of being made. Ask for a new one:",
  adminsOnlyTitle: "This team's dashboard is limited to its admins",
  adminsOnlyText: "Your own numbers are available in your agent.",
  failedTitle: "Could not open the link",
  failedText: "The server could not be reached. The link may still work if you try again within 5 minutes of making it.",
  tryAgain: "Try again",
};

export type OpenKey = keyof typeof en;

const ru: Record<OpenKey, string> = {
  title: "Открыть дашборд · teamusage",
  language: "Язык",
  howTitle: "Откройте дашборд из своего агента",
  howIntro: "Ваше устройство запрашивает одноразовую ссылку и открывает её здесь. Не нужно вводить код или создавать аккаунт.",
  askAgent: "Попросите агента в Claude Code или Codex",
  agentPhrase: "открой дашборд команды",
  orTerminal: "Или выполните в терминале",
  howNote: "Ссылка срабатывает один раз и действует 5 минут. После этого вход в этом браузере сохраняется 30 дней. Нужна версия teamusage 0.4.0 или новее.",
  adminsNote: "В некоторых командах дашборд открыт только администраторам. Ваша собственная статистика всегда доступна в агенте.",
  ownerPrompt: "Владелец, администратор или наблюдатель?",
  signInGithub: "Войти через GitHub",
  signInCode: "Войти по инвайт-коду",
  opening: "Открываем дашборд вашей команды…",
  confirmTitle: "Открыть дашборд как участник команды?",
  signedInGithub: "В этом браузере выполнен вход через GitHub",
  confirmText:
    "В браузере может быть только один вход. Эта ссылка заменит вход через GitHub: вы увидите дашборд как участник, а на странице команды нужно будет снова войти через GitHub.",
  openAsMember: "Открыть как участник",
  stayGithub: "Оставить вход через GitHub",
  confirmNote: "Ссылка срабатывает один раз и перестаёт действовать через 5 минут после того, как агент её создал.",
  expiredBadge: "Ссылка не открыта",
  expiredTitle: "Эта ссылка больше не действует",
  expiredText: "Ссылка открывает дашборд один раз и только в течение 5 минут после создания. Запросите новую:",
  adminsOnlyTitle: "Дашборд этой команды открыт только администраторам",
  adminsOnlyText: "Ваша собственная статистика доступна в агенте.",
  failedTitle: "Не удалось открыть ссылку",
  failedText: "Сервер недоступен. Ссылка может ещё сработать, если повторить попытку в течение 5 минут после её создания.",
  tryAgain: "Повторить",
};

export const strings: Table<OpenKey> = { en, ru };
