/** The team code card and its "Replace the team code?" dialog. */

export const en = {
  codeTitle: "Team code",
  codeNote: "Anyone with this code can join the team. Send it privately, not in a group chat.",
  codeHidden: "Hidden",
  show: "Show",
  hide: "Hide",
  copyCode: "Copy code",
  copied: "Copied",
  replaceCode: "Replace code…",
  replaceNote: "Replacing makes a new code, and the old one stops letting people join. Nobody is signed out, and machines that already joined keep sending.",
  codeNotShown: "This code can no longer be shown. Replace it to get a new one.",
  copyCodeFailed: "Could not copy. Press Show and copy the code yourself.",
  replaceTitle: "Replace the team code?",
  replaceText:
    "The old code stops letting people join at once. Nobody is signed out, and machines that already joined keep sending. People who have not joined yet need the new code.",
  replaceConfirm: "Replace code",
  replacing: "Replacing…",
};

export const ru: Record<keyof typeof en, string> = {
  codeTitle: "Код команды",
  codeNote: "Любой, у кого есть этот код, может вступить в команду. Отправляйте его лично, а не в общий чат.",
  codeHidden: "Скрыт",
  show: "Показать",
  hide: "Скрыть",
  copyCode: "Скопировать код",
  copied: "Скопировано",
  replaceCode: "Заменить код…",
  replaceNote:
    "После замены появится новый код, а по старому вступить будет уже нельзя. Никому не придётся входить заново, а устройства, которые уже вступили, продолжат отправку.",
  codeNotShown: "Этот код больше нельзя показать. Замените его, чтобы получить новый.",
  copyCodeFailed: "Не удалось скопировать. Нажмите «Показать» и скопируйте код сами.",
  replaceTitle: "Заменить код команды?",
  replaceText:
    "По старому коду сразу перестанет получаться вступить. Никому не придётся входить заново, а устройства, которые уже вступили, продолжат отправку. Тем, кто ещё не вступил, понадобится новый код.",
  replaceConfirm: "Заменить код",
  replacing: "Заменяем…",
};
