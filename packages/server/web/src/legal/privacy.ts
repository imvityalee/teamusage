import type { Lang } from "../lang.js";
import { facts, placeholder, type LegalSection } from "./section.js";

export type { LegalSection };

/**
 * The privacy policy. Its sections of facts describe the product as it is (README "Exactly what is sent", the
 * hosted design's amendments, and the code); the sections of placeholders are the owner's to write before launch.
 */

const en: LegalSection[] = [
  facts(
    "What is sent",
    "For each day, agent and model, one record is sent: the date, the agent, the model, the input, output, cache-create and cache-read token counts and their total, the estimated cost in US dollars, and whether the model had no known price.",
    "For Claude and Codex, the records of your local today and yesterday also carry an account label (personal, team, enterprise or api; for Claude team and enterprise accounts, also the organisation's name) and the plan, when it is recognised.",
    "When a machine joins a team, it sends once your name, your email, a machine id (a hash: the machine's own identifier never leaves it) and the hostname, as a label. The team sees the hostname and the time of that machine's last sync.",
    "The command teamusage sync --dry-run prints the exact payload and sends nothing.",
  ),
  facts(
    "What is never sent",
    "Prompts or replies, code, file paths, project or repository names, session contents, your account's email, account IDs, workspace IDs or sign-in tokens.",
  ),
  facts(
    "Who can see a team's numbers",
    "A team's numbers are open to its owner, its admins and its viewers. When the owner chose \"Every member\", every member of the team can also open the dashboard from their coding agent. Nobody outside the team can open it.",
    "The person who runs the service can read the database, which holds every team's data.",
  ),
  facts(
    "Accounts",
    "Team members have no account: a machine joins with the team code, a name and an email, which the team keeps as its record of that member.",
    "Owners, admins and viewers sign in with GitHub. Of your GitHub account the service keeps the numeric id and the login. It asks GitHub for no extra permissions and keeps no email, no access token and no access to your repositories.",
  ),
  facts(
    "What a browser keeps",
    "After you sign in, one sign-in cookie that lasts 30 days. While you sign in with GitHub, one more cookie that lasts 10 minutes and serves only that sign-in.",
    "Your choice of language, in the browser's local storage. The number of rows a table shows per page is kept there too. An invitation's token waits in the tab's session storage while you sign in with GitHub. It is removed once the invitation is used or no longer valid, and in any case when you close the tab.",
    "Nothing else: no analytics, no advertising, and nothing is loaded from other sites.",
  ),
  facts(
    "Known limits",
    "A member's email is not verified, so someone who has the team code can register under a colleague's email. They then count as that colleague: they can see that colleague's own numbers and send usage under their name.",
    "A leaked team code lets a stranger join and send data until an admin removes them and replaces the code. While the team is set to \"Every member\", that stranger can also open the dashboard and see every member's numbers.",
  ),
  facts(
    "Keeping and deleting",
    "Usage dated more than 24 months (730 days) before today is deleted over the team's next syncs. A team that sends nothing keeps it.",
    "Removing a member or deleting a team erases their data at once. Copies in backups age out within the backup's retention.",
  ),
  ...[
    "Who is responsible for your data",
    "Legal basis",
    "Where the data is hosted and how long backups are kept",
    "Your rights and how to use them",
    "Contact",
    "Changes to this policy",
  ].map((heading) => placeholder("en", heading)),
];

const ru: LegalSection[] = [
  facts(
    "Что отправляется",
    "За каждый день, агента и модель отправляется одна запись: дата, агент, модель, число входных, выходных, записанных в кэш и прочитанных из кэша токенов, их сумма, оценка стоимости в долларах США и отметка, что у модели нет известной цены.",
    "Для Claude и Codex записи за ваши локальные сегодня и вчера также содержат метку аккаунта (личный, командный, корпоративный или API; для командных и корпоративных аккаунтов Claude ещё и название организации) и тариф, если он распознан.",
    "Когда устройство подключается к команде, оно один раз отправляет ваше имя, ваш email, идентификатор устройства (хеш; исходный идентификатор устройства никуда не передаётся) и имя хоста как метку. Команда видит имя хоста и время последней отправки с этого устройства.",
    "Если запустить teamusage sync --dry-run, он выведет точное содержимое отправки и ничего не отправит.",
  ),
  facts(
    "Что не отправляется никогда",
    "Запросы и ответы, код, пути к файлам, названия проектов и репозиториев, содержимое сессий, email вашего аккаунта, идентификаторы аккаунтов и рабочих пространств, токены входа.",
  ),
  facts(
    "Кто видит данные команды",
    "Данные команды открыты её владельцу, администраторам и наблюдателям. Если владелец выбрал «Все участники», дашборд из своего агента может открыть и каждый участник команды. Тем, кто не входит в команду, дашборд недоступен.",
    "Тот, кто обслуживает сервис, может читать базу данных, в которой хранятся данные всех команд.",
  ),
  facts(
    "Аккаунты",
    "У участников команды нет аккаунтов: устройство подключается по коду команды и сообщает имя и email; их команда хранит как запись об этом участнике.",
    "Владельцы, администраторы и наблюдатели входят через GitHub. Из данных вашего аккаунта GitHub сервис хранит только числовой идентификатор и логин. Он не просит у GitHub дополнительных разрешений, не хранит ни email, ни токен доступа и не получает доступа к вашим репозиториям.",
  ),
  facts(
    "Что хранит браузер",
    "После входа браузер хранит один cookie входа на 30 дней. Пока вы входите через GitHub, есть ещё один cookie на 10 минут, он нужен только для этого входа.",
    "Выбранный язык хранится в локальном хранилище браузера. Там же хранится выбранное число строк на странице таблицы. Токен приглашения хранится в сессионном хранилище вкладки, пока вы входите через GitHub. Он удаляется, когда приглашение использовано или больше не действует, и в любом случае — когда вы закрываете вкладку.",
    "Больше ничего: ни аналитики, ни рекламы, и ничего не загружается с других сайтов.",
  ),
  facts(
    "Известные ограничения",
    "Email участника не проверяется, поэтому тот, у кого есть код команды, может зарегистрироваться под email коллеги. Тогда сервис считает его этим коллегой: он видит его собственную статистику и может отправлять данные от его имени.",
    "Если код команды утёк, посторонний может присоединиться и отправлять данные, пока администратор не удалит его и не заменит код. Если для команды выбрано «Все участники», он также может открыть дашборд и увидеть статистику всех участников.",
  ),
  facts(
    "Хранение и удаление",
    "Данные об использовании старше 24 месяцев (730 дней) удаляются при нескольких ближайших отправках команды. У команды, которая ничего не отправляет, они сохраняются.",
    "Когда участника или команду удаляют, их данные стираются сразу. В резервных копиях они остаются, пока не истечёт срок хранения копий.",
  ),
  ...[
    "Кто отвечает за ваши данные",
    "Правовое основание",
    "Где хранятся данные и как долго хранятся резервные копии",
    "Ваши права и как ими воспользоваться",
    "Контакты",
    "Изменения политики",
  ].map((heading) => placeholder("ru", heading)),
];

export const PRIVACY: Record<Lang, LegalSection[]> = { en, ru };
