import type { Lang } from "../i18n.js";
import { facts, placeholder, type LegalSection } from "./section.js";

export type { LegalSection };

/**
 * The privacy policy. Its sections of facts describe the product as it is (README "Exactly what is sent", the
 * hosted design's amendments, and the code); the sections of placeholders are the owner's to write before launch.
 */

const en: LegalSection[] = [
  facts(
    "What is sent",
    "For each day, agent and model, one record is sent: the date, the agent, the model, the input, output, cache-create and cache-read token counts and their total, and the estimated cost in US dollars.",
    "For Claude and Codex it also carries an account label (personal, team, enterprise or api; for Claude team and enterprise accounts, also the organisation's name) and the plan, when it is recognised.",
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
    "Your choice of language, in the browser's local storage. An invitation's token waits in the tab's session storage while you sign in with GitHub and is removed when it is used.",
    "Nothing else: no analytics, no advertising, and nothing is loaded from other sites.",
  ),
  facts(
    "Known limits",
    "A member's email is not verified, so someone who has the team code can register under a colleague's email.",
    "A leaked team code lets a stranger join and send data until an admin removes them and replaces the code.",
  ),
  facts(
    "Keeping and deleting",
    "Usage dated more than 24 months (730 days) before today is deleted when the team's machines next send usage. A team that sends nothing keeps it.",
    "Removing a member or deleting a team erases the rows at once. Copies in backups age out within the backup's retention.",
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
    "За каждый день, агента и модель отправляется одна запись: дата, агент, модель, число входных, выходных, записанных в кэш и прочитанных из кэша токенов, их сумма и оценка стоимости в долларах США.",
    "Для Claude и Codex к записи добавляются метка аккаунта (личный, командный, корпоративный или API; для командных и корпоративных аккаунтов Claude ещё и название организации) и тариф, если он распознан.",
    "Когда устройство подключается к команде, оно один раз отправляет ваше имя, ваш email, идентификатор устройства (хеш: собственный идентификатор устройства его не покидает) и имя хоста как метку. Команда видит имя хоста и время последней отправки с этого устройства.",
    "Команда teamusage sync --dry-run печатает точное содержимое отправки и ничего не отправляет.",
  ),
  facts(
    "Что не отправляется никогда",
    "Запросы и ответы, код, пути к файлам, названия проектов и репозиториев, содержимое сессий, email вашего аккаунта, идентификаторы аккаунтов и рабочих пространств, токены входа.",
  ),
  facts(
    "Кто видит данные команды",
    "Данные команды открыты её владельцу, администраторам и наблюдателям. Если владелец выбрал «Каждый участник», дашборд из своего агента может открыть и каждый участник команды. Тем, кто не входит в команду, дашборд недоступен.",
    "Человек, который запускает сервис, может читать базу данных, в которой лежат данные всех команд.",
  ),
  facts(
    "Аккаунты",
    "У участников команды нет аккаунтов: устройство подключается по коду команды, имени и email, которые команда хранит как запись об этом участнике.",
    "Владельцы, администраторы и наблюдатели входят через GitHub. От вашего аккаунта GitHub сервис хранит числовой идентификатор и логин. Он не просит у GitHub дополнительных разрешений и не хранит ни email, ни токен доступа, ни доступ к вашим репозиториям.",
  ),
  facts(
    "Что хранит браузер",
    "После входа браузер хранит один cookie входа на 30 дней. Пока вы входите через GitHub, есть ещё один cookie на 10 минут, он нужен только для этого входа.",
    "Выбранный язык хранится в локальном хранилище браузера. Токен приглашения ждёт в хранилище сессии вкладки, пока вы входите через GitHub, и удаляется, когда приглашение использовано.",
    "Больше ничего: ни аналитики, ни рекламы, и ничего не загружается с других сайтов.",
  ),
  facts(
    "Известные ограничения",
    "Email участника не проверяется, поэтому тот, у кого есть код команды, может зарегистрироваться под email коллеги.",
    "Если код команды утёк, посторонний может присоединиться и отправлять данные, пока администратор не удалит его и не заменит код.",
  ),
  facts(
    "Хранение и удаление",
    "Данные об использовании старше 24 месяцев (730 дней) удаляются, когда устройства команды в очередной раз отправляют данные. Команда, которая ничего не отправляет, хранит их как есть.",
    "Когда вы удаляете участника или команду, их строки стираются сразу. Копии в резервных копиях исчезают по истечении срока хранения резервных копий.",
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
