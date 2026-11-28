/**
 * The invite message card. The message is board 3's, with the README's commands (ruling R21), step 5 as corrected and
 * the settings fields named by the plugin's own titles; `{origin}` is this server's own address. It never holds the team code.
 */

export const en = {
  inviteTitle: "Invite message",
  inviteNote: "Send this to your team. It does not contain the code.",
  messageLanguage: "Message language",
  copyMessage: "Copy message",
  copyMessageFailed: "Could not copy. Select the message and copy it yourself.",
  message: [
    "teamusage: connect your machine (about 5 minutes)",
    "",
    "1. Install Node.js 22 or newer: https://nodejs.org",
    "2. In Claude Code, type:",
    "     /plugin marketplace add imvityalee/teamusage",
    "     /plugin install teamusage@teamusage",
    "3. When it asks for the settings, enter:",
    "     Server URL: {origin}",
    "     Invite code: the team code I sent you privately",
    "     Your name and Your email: your work name and work email",
    "4. Start a new Claude Code session. Your usage is sent automatically from now on.",
    '5. Check it: ask Claude "send my usage", then "open the team dashboard".',
    "",
    "Using Codex? Run once in a terminal: npx -y teamusage@0.3.1 setup",
  ].join("\n"),
};

export const ru: Record<keyof typeof en, string> = {
  inviteTitle: "Сообщение для команды",
  inviteNote: "Отправьте его своей команде. Кода в нём нет.",
  messageLanguage: "Язык сообщения",
  copyMessage: "Скопировать сообщение",
  copyMessageFailed: "Не удалось скопировать. Выделите сообщение и скопируйте его сами.",
  message: [
    "teamusage: подключите своё устройство (около 5 минут)",
    "",
    "1. Установите Node.js 22 или новее: https://nodejs.org",
    "2. В Claude Code введите:",
    "     /plugin marketplace add imvityalee/teamusage",
    "     /plugin install teamusage@teamusage",
    "3. Когда плагин попросит настройки, введите:",
    "     Server URL: {origin}",
    "     Invite code: код команды из моего личного сообщения",
    "     Your name и Your email: ваше имя и рабочую почту",
    "4. Начните новую сессию Claude Code. С этого момента ваш расход токенов отправляется автоматически.",
    "5. Проверьте: попросите Claude «отправь мою статистику», а затем «открой дашборд команды».",
    "",
    "Используете Codex? Один раз выполните в терминале: npx -y teamusage@0.3.1 setup",
  ].join("\n"),
};
