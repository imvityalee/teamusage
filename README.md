# teamusage

A small self-hosted server and command-line tool that show how much your team uses coding agents.
Each person's machine reads its own local usage logs and sends token counts to a server you run.
The server shows one dashboard for the whole team: tokens and estimated cost by person, agent and day.
You can filter it by agent and model, and every member has a page of their own.

It is built for teams that want these numbers without handing them to a third party. You host the server,
you hold the data, and the data sent is small and fixed (see [Exactly what is sent](#exactly-what-is-sent)).
Only work that runs on a person's own machine can be counted; cloud sessions cannot (see
[What is counted and what is not](#what-is-counted-and-what-is-not)).

## Try it in two commands

You need Docker. Build the image from a clone of this repository, then start it in demo mode:

```sh
docker build -f packages/server/Dockerfile -t teamusage .
docker run --rm -p 8787:8787 -e TEAMUSAGE_DEMO=1 teamusage
```

Open <http://localhost:8787>. Demo mode shows made-up data kept in memory. Nothing is saved, and no
invite code is needed. (A pre-built image is not published yet.)

## Run it for your team

The server is one container. It keeps everything in a SQLite file in `/data`, so mount a volume there.

```sh
docker run -d --name teamusage --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v teamusage-data:/data \
  -e TEAMUSAGE_TRUSTED_PROXIES=1 \
  teamusage
docker logs teamusage        # prints the invite code on the first start only
```

The invite code is how people join. If you do not set `TEAMUSAGE_INVITE_CODE`, the server generates one,
keeps it in the database and prints it in the log once, on the first start. Afterwards, show it with
`docker exec teamusage teamusage-admin show-invite`. To choose your own, set
`TEAMUSAGE_INVITE_CODE` to 16 to 128 characters with no spaces.

The container runs as a non-root user (uid 10001). A named volume works as is. If you use a bind mount
instead, make the directory writable by uid 10001.

### Upgrading

Upgrade the server first. Rebuild the image, run `docker rm -f teamusage`, and start it again with the
same `docker run` command and the same volume. Members, tokens and dashboard sessions are kept. The first
start with this release adds columns to the usage table in place; there is nothing for you to run.

Upgrade the server before the clients: an older server rejects uploads that carry Codex account labels.
Clients on 0.1.0 and 0.2.0 keep working against the new server. Their usage shows as "Unknown" in the
account views when they send no account label. After the server, members update the Claude Code plugin to
this release, which runs `teamusage@0.3.0`, and Codex users install the Codex plugin (see
[Codex](#codex)). Anyone who installed the client globally runs `npm install -g teamusage@0.3.0`.

"Unknown" now means unlabelled Claude usage only. Usage of other agents without an account label shows
as "Other agents", and the `unknown` account filter matches Claude usage only.

To update the plugin, run `claude plugin update teamusage@teamusage` in your shell, or open `/plugin`,
select `teamusage` on the Installed tab and choose Update now. A third-party marketplace does not
auto-update by default. The running session keeps the old version until the next session or
`/reload-plugins`.

A 0.3.0 client against an older server: machines with a Codex login have every upload refused until the
server is upgraded. Nothing is lost; it is sent again after the upgrade. Claude-only machines still upload,
without plans.

An existing Codex MCP registration stays on the version it was registered with (0.2.0 `setup` registered
one by default). A registration like that also hides the plugin's own MCP server, so anyone who registered
teamusage with Codex before and now uses the plugin runs `codex mcp remove teamusage` first. People who do
not use the plugin re-run `teamusage setup --codex` to move the registration to 0.3.0. To upgrade the Codex
plugin, see [Codex](#codex).

After upgrading, a member can give past days their plan and account label once: see
[Labelling past usage](#labelling-past-usage).

### Put it behind HTTPS (recommended)

The server speaks plain HTTP. Put it behind a reverse proxy that terminates HTTPS, so that tokens and
invite codes are never sent unencrypted. The client refuses a plain `http://` server unless it is
`localhost`, unless the user opts in (see below). With [Caddy](https://caddyserver.com) this is a
two-line `Caddyfile`:

```
usage.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Set `TEAMUSAGE_TRUSTED_PROXIES=1` (the number of proxies in front of the server) so the failed-attempt
limit counts each person by their real address. Leave it at 0 if nothing sits in front: the server
then ignores `X-Forwarded-For`, which a client could otherwise forge.

### Server settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on inside the container. |
| `TEAMUSAGE_HOST` | `0.0.0.0` | Address to listen on. |
| `TEAMUSAGE_DATA_DIR` | `/data` | Where the database is kept. |
| `TEAMUSAGE_INVITE_CODE` | generated | The invite code, 16 to 128 characters, no spaces. |
| `TEAMUSAGE_TRUSTED_PROXIES` | `0` | How many reverse proxies are in front (0 to 10). |
| `TEAMUSAGE_DEMO` | unset | `1` starts demo mode. The `--demo` flag does the same when you run `node dist/main.js` directly; with Docker, set `TEAMUSAGE_DEMO=1`, because arguments to `docker run` replace the command. |

An invalid value stops the server at startup with a short message that does not repeat the value.
The image has a health check that calls `/api/health`.

### Operator commands

Run these inside the container. They work on the same database, so they can run while the server is up.

```sh
docker exec teamusage teamusage-admin members                    # list members and their machines
docker exec teamusage teamusage-admin remove-member <email>      # delete a member and all their data
docker exec teamusage teamusage-admin remove-machine <id>        # delete one machine and its data
docker exec teamusage teamusage-admin show-invite                # print the stored invite code
docker exec teamusage teamusage-admin rotate-invite              # new invite code; ends all dashboard sessions
```

`show-invite` prints no code when the code is pinned by `TEAMUSAGE_INVITE_CODE`; read it from where you set the
variable. `rotate-invite` also refuses; to change a pinned code, change the variable and restart the container.

To open the dashboard, visit the server's address and enter the invite code. Dashboard sessions last
30 days.

### Back up and move

Everything the server knows is in one SQLite file, `teamusage.sqlite`, in the `teamusage-data` volume:
members, machines, usage history and, if the server generated it, the invite code. There is no other
database to run or back up.

The backup contains the invite code and everyone's names, emails and machine names. Keep it as private
as the server itself.

**Back up.** Stop the container first. The database keeps its most recent writes in a companion file
until it is closed, so a copy taken while the server is running can miss rows. The dated name and your
user and group ids come from your own shell, before Docker runs. The archive is created private
(mode 600) and then handed to you, so you can read and copy it without `sudo`, on Linux and on macOS.

```sh
f=teamusage-backup-$(date +%F).tar.gz
uid=$(id -u); gid=$(id -g)
docker stop teamusage
docker run --rm -v teamusage-data:/data -v "$PWD":/backup node:22-slim \
  sh -c 'umask 077 && tar -czf "/backup/$1" -C /data . && chown "$2:$3" "/backup/$1"' sh "$f" "$uid" "$gid" ;
docker start teamusage
```

The `;` makes `docker start teamusage` run even if the copy fails, so a failed copy cannot leave the
server stopped. In a script, do not use `set -e` or `&&` between these steps for the same reason.
Because a failed copy passes silently, always check the archive:

```sh
ls -l "$f"                      # the file exists and is not empty
tar -tzf "$f" | grep teamusage.sqlite   # prints ./teamusage.sqlite
```

The dashboard is unavailable for those few seconds. Nothing is lost: each member's machine sends the
same days again on its next sync. To do this on a schedule, put the commands in a script and run it
from cron. Each run writes a new dated file, so keep several of them and delete the old ones yourself.

**Restore, or move to another server.** Restore only into a new, empty volume that no container is
using. A running server, or leftover companion files from an old database, can corrupt the restored one.

On a new server, build or load the image, put the archive in the current directory, and run (use the
archive's own file name):

```sh
f=teamusage-backup-2026-11-18.tar.gz
docker volume create teamusage-data
docker run --rm -v teamusage-data:/data -v "$PWD":/backup node:22-slim \
  sh -c 'tar -xzf "/backup/$1" -C /data && chown -R 10001:10001 /data' sh "$f"
```

Then start the container exactly as in [Run it for your team](#run-it-for-your-team).

**Restoring on the same server is destructive. Do the steps in this order.**

1. Make a backup as above and check it: the archive exists, is not empty, and `tar -tzf "$f"` lists
   `./teamusage.sqlite`.
2. Only then remove the old container and volume. `docker volume rm` permanently deletes the current
   database and cannot be undone.

   ```sh
   docker rm -f teamusage
   docker volume rm teamusage-data
   ```

3. Create the volume and restore as on a new server (the commands above), then start the container.

Members, tokens and usage history come with the file. The invite code comes with it only when the server
generated it. If you pinned it with `TEAMUSAGE_INVITE_CODE`, pass the same variable to the new server.

- **If the server keeps the same address,** nobody on the team has to do anything.
- **If the address changes,** a saved token is tied to the address it was issued for, so after the
  change the client sends nothing and says to run `teamusage setup`. Everyone runs `teamusage setup`
  once in a terminal and enters the new address (or passes `--server`); it registers again, so it asks
  for the invite code. `teamusage setup` does not read the Claude Code plugin's settings, and a config
  file saved by an earlier `setup` overrides them. So plugin users also change the Server URL in the
  plugin's settings (`/plugin configure teamusage@teamusage`), so that both agree.

Restore a backup somewhere once before you rely on it: a backup that has never been restored is not
yet proven.

**One server, one file.** SQLite serves one server process. That is plenty for a team's usage data,
and it is why there is nothing else to install. Two servers cannot share one database file; run a
single server per team.

## Invite your team

Once the server runs, send each person the message below with your own address. Send the invite code
separately and privately (a password manager or a direct message), not in a group chat.

```text
teamusage: connect your machine (about 5 minutes)

1. Install Node.js 22 or newer: https://nodejs.org
2. In Claude Code, type:
     /plugin marketplace add imvityalee/teamusage
     /plugin install teamusage@teamusage
3. When it asks for the settings, enter:
     Server URL:  https://usage.example.com
     Invite code: the code I sent you privately
     Your name and Your email: your work name and work email
4. Start a new Claude Code session. From now on Claude Code sends your usage automatically
   when a session starts and when it ends, and at most every 4 hours after a reply.
5. Check it: ask Claude "send my usage", then find yourself on https://usage.example.com

Using Codex? In a terminal, once:
     npx -y teamusage@0.3.0 setup
   (server URL, invite code, your name and email). If you registered teamusage with Codex
   before, first run: codex mcp remove teamusage (the plugin brings its own MCP server). Then:
     codex plugin marketplace add imvityalee/teamusage
     codex plugin add teamusage@teamusage
   Then in Codex type /hooks and trust the teamusage hooks. Trust them again after
   each plugin upgrade. Codex usage is sent when a session starts and at most every
   4 hours after a reply. On Windows, run "npx -y teamusage@0.3.0 sync" yourself.
```

```text
teamusage: подключите свой компьютер (около 5 минут)

1. Установите Node.js 22 или новее: https://nodejs.org
2. В Claude Code введите:
     /plugin marketplace add imvityalee/teamusage
     /plugin install teamusage@teamusage
3. Когда спросит настройки, введите:
     Server URL:  https://usage.example.com
     Invite code: код, присланный вам лично
     Your name и Your email: рабочие имя и почта
4. Начните новую сессию Claude Code. Дальше Claude Code отправляет статистику сам
   при начале и при завершении каждой сессии, а также не чаще раза в 4 часа после ответа.
5. Проверка: попросите Claude «отправь статистику» и найдите себя на https://usage.example.com

Используете Codex? В терминале, один раз:
     npx -y teamusage@0.3.0 setup
   (адрес сервера, код приглашения, ваши имя и почта). Если вы раньше регистрировали
   teamusage в Codex, сначала выполните: codex mcp remove teamusage (плагин приносит
   собственный MCP-сервер). Затем:
     codex plugin marketplace add imvityalee/teamusage
     codex plugin add teamusage@teamusage
   Потом в Codex введите /hooks и доверьте хуки teamusage. После каждого обновления
   плагина доверьте их снова. Статистика Codex отправляется при начале сессии и не
   чаще раза в 4 часа после ответа. В Windows запускайте
   «npx -y teamusage@0.3.0 sync» сами.
```

If something does not arrive, the person runs `npx -y teamusage@0.3.0 status` in a terminal and reads
`sync.log` in `~/.config/teamusage`. Details on each path follow below.

## Join as a team member

Prerequisite: Node.js 22 or newer, with `npx`. You also need the server address and the invite code
from whoever runs the server.

From npm:

```sh
npx teamusage setup
```

It asks for the server URL, the invite code (not echoed), your name and your email, registers this machine
and runs a first sync. Or from source:

```sh
pnpm install && pnpm build
node packages/client/dist/cli.js setup
```

Enter the invite code at the prompt, or set it in the environment (`TEAMUSAGE_INVITE_CODE`, along with
`TEAMUSAGE_SERVER_URL`, `TEAMUSAGE_NAME` and `TEAMUSAGE_EMAIL` if you want to skip those prompts). Avoid
`--invite` on the command line: it stays in shell history and is visible in process listings. The invite
code is not stored unless you pass `--save-invite`.

Other commands (`npx teamusage ...`; from source `node packages/client/dist/cli.js ...`):

```sh
teamusage sync              # collect and upload now
teamusage sync --dry-run    # print exactly what would be sent; send nothing
teamusage sync --label-history  # label all your past Claude and Codex days (see "Labelling past usage")
teamusage sync --quiet      # print nothing, always exit 0; failures go to sync.log in the config directory
teamusage sync --detach     # run "sync --quiet" in the background and return at once
teamusage sync --throttle 4h  # do nothing if a sync attempt started less than 4 hours ago (1m to 24h, or 1m to 1440m)
teamusage status            # config, last sync, and whether the server is reachable
teamusage stats             # your usage per model and the team total, last 30 days
teamusage stats --range 3m  # the same for the last 3 months (1m, 3m or 6m)
teamusage mcp               # serve the MCP tools (see below) over stdio to an MCP client
```

The config is saved at `~/.config/teamusage/config.json`, readable only by you. When `XDG_CONFIG_HOME` is set
to an absolute path, it is `$XDG_CONFIG_HOME/teamusage/config.json` instead (a relative value is ignored).

If your server is plain HTTP on a non-local address, setup refuses. HTTPS is the right fix. If you
accept the risk on a trusted network, use `teamusage setup --allow-insecure-http` (or set
`TEAMUSAGE_ALLOW_INSECURE_HTTP=1`); the token and invite code then travel unencrypted.

A saved token is bound to the server URL and email it was issued for. If either changes, or the binding is
missing from the config file, sync sends nothing until you run `teamusage setup` again.

Running `teamusage setup` again with a different email registers a second member. The old member and its
history stay on the server, and both count in the team totals, until an operator removes the old one with
`teamusage-admin remove-member <old email>`.

### MCP tools

`teamusage mcp` serves three tools to any MCP client over stdio:

- `sync_usage`: collect and upload now, as `teamusage sync` does. A second call within a minute returns
  the previous result marked `cached` instead of running again. Its optional `labelHistory: true` is the
  same as `--label-history`; use it only when you explicitly ask to label past usage.
- `get_my_usage` and `get_team_usage`: your usage per model, or the team's per member and per model,
  for the last `1m`, `3m` or `6m` (default `1m`), with the note that cost is an estimate.

They use the same config as the other commands. The Claude Code plugin below registers them for you.

## Use it from Claude Code

This repository is also a Claude Code plugin marketplace. The plugin sends your usage automatically when
Claude Code sessions start and end and during a session at most every 4 hours, and adds two skills and the MCP tools above. It runs the client from
npm at a pinned version (`npx -y teamusage@0.3.0`). Inside Claude Code:

```
/plugin marketplace add imvityalee/teamusage
/plugin install teamusage@teamusage
```

Start a new session after installing, so the session hooks are loaded.

You need Node.js 22 or newer, with `npx`. In organisations that restrict plugin marketplaces (Claude Code's
`strictKnownMarketplaces` and `blockedMarketplaces` settings), an admin may need to allow this marketplace
first.

Claude Code asks for the plugin's settings when you install it. To change them later, run
`/plugin configure teamusage@teamusage`.

| Setting | What it is for |
| --- | --- |
| Server URL | The server's address. `https://`, or plain `http://` for `localhost` only. |
| Invite code | Registers this machine with the server. The input is masked, and Claude Code keeps it in the system's secure credential store, not in `settings.json`. |
| Your name | Your name on the dashboard. |
| Your email | Identifies you on the server. The same email on several machines counts as one person. |
| Allow insecure HTTP | Off by default. Allows a plain `http://` server on a non-local address; the invite code and token are then sent unencrypted. Use HTTPS instead. |

The settings reach the client only through environment variables, never on a command line. The token
the server issues is saved in the client's config file as with `teamusage setup`; the invite code is not.
If you ran `teamusage setup` on this machine earlier, the values saved in its config file take priority
over the plugin's settings. Run `teamusage status` in a terminal (without any `TEAMUSAGE_` variables set):
if its `Server:` and `Member:` lines show values, the config file wins; if both say `not set`, the
plugin's settings apply. To change the saved values, run `teamusage setup` again.

A sync registers this machine by itself (when there is no saved token, or when the server rejects the
saved one) only if the server URL and the invite code come from the same place: both from the environment (the
plugin's settings reach the client as `TEAMUSAGE_*` variables, so values set in your shell count as the
same place as the plugin's settings), or both from the config file (`teamusage setup --save-invite`). So the plugin's invite code is
never sent to a server named in the config file, or the reverse. If they come from different places, for
example after `teamusage setup` without `--save-invite`, the sync does not register: it stops with a
message to run `teamusage setup` (with the plugin's hooks, look in `sync.log`).

Your name and email are sent to the server only when this machine registers. When the plugin's settings
apply, changing your name there has no effect on the server until the machine registers again. Changing
your email there stops sending, because the saved token is bound to the old email, until you run
`teamusage setup`; that creates a second member, as described above.

To use the plugin's settings instead of the config file, delete the config file,
`~/.config/teamusage/config.json` (or `$XDG_CONFIG_HOME/teamusage/config.json` when that variable is an
absolute path). This discards the saved token and the record of the last successful sync. The next sync
from the plugin then registers this machine again with the plugin's invite code and sends all usage
history again. If the invite code in the plugin's settings is out of date (the operator has rotated it
since), that registration fails and nothing is sent: the hooks print nothing, and `sync.log` in the config
directory shows `sync failed: server responded 403: invalid invite code`. Enter the current code with
`/plugin configure teamusage@teamusage`, or run `teamusage setup`. The server stores usage per machine and
keeps the higher totals, so registering again does not double-count, as long as the machine keeps its id.
The id is derived from the operating system's machine identifier and your email; on systems without such an
identifier, it is derived from a random value saved in that same file instead, which is lost too, and the
server then sees a new machine.

**What the plugin trusts.** Each time the hooks or the MCP server start, the plugin downloads (on first
use) and runs the `teamusage` package from the npm registry, with your own permissions. The version is
pinned exactly, so a later release is never picked up automatically, but the package contents are not
checked against a hash: you are trusting the npm registry and the package name. The `-y` flag skips npm's
confirmation prompt. If you prefer not to, skip the plugin and run a client you have reviewed yourself.
Today that means building it from this repository:

```sh
pnpm install && pnpm build
node packages/client/dist/cli.js setup
node packages/client/dist/cli.js sync
```

You can instead install it from npm with
`npm install -g teamusage@0.3.0` and use `teamusage setup`, `teamusage sync` and
`teamusage schedule install` (see [Scheduled sync](#scheduled-sync)).

**Automatic sending.** When a session starts (new or resumed) and when it ends, the plugin runs
`npx -y teamusage@0.3.0 sync --quiet --detach`. The client returns at once, the sync continues in the
background, the client prints nothing, and failures go to `sync.log` in the config directory.

A `Stop` hook, which Claude Code runs after each reply, runs the same command with `--throttle 4h`. The
hook starts each time, and the client exits at once without syncing unless the last sync attempt on this
machine started 4 or more hours ago, so a long session is sent about every 4 hours, not after every reply. A failed attempt also starts the 4-hour
window. The session start and end hooks, a manual `teamusage sync`, the MCP tool and the scheduled job
are never throttled. They do start the window, because it is measured from the last attempt of any
kind. The time is kept in a `last-attempt` file in the config directory. The first
run downloads the package, and `npx` itself may print download or npm notices. It sends only the
numbers listed in [Exactly what is sent](#exactly-what-is-sent), for every agent ccusage finds on the
machine, and nothing else; the client does not read the session information Claude Code passes to hooks.

On the very first run, the session-end hook may be cut short while the package downloads (Claude Code
gives session-end hooks very little time). The next sync, for example from the next session-start
hook, sends every day from two days before the last successful sync onward (all history if there has
been none), so the days a cut-short hook missed are included.

Automatic sending through the hooks does not work on native Windows in this version, because the hooks
cannot launch `npx` there; the scheduled job is not supported on Windows either. Manual `teamusage sync`
and the `teamusage mcp` command are unaffected.

**Skills.** Ask in plain English or Russian, or type the command:

- `/teamusage:usage-sync` sends your usage now: "send my usage", "sync token usage",
  «отправь статистику», «отправь расход токенов».
- `/teamusage:usage-stats` shows your usage or the team's for the last 1, 3 or 6 months as a short
  table: "show my teamusage stats", "team token usage this month", «покажи мой расход токенов в teamusage»,
  «статистика команды по токенам».

Claude answers in the language you asked in. The skills never ask for the invite code in the chat; if
the plugin is not set up, they point you to `/plugin configure teamusage@teamusage`.

**Remove it** with `/plugin uninstall teamusage@teamusage` in Claude Code, or
`claude plugin uninstall teamusage@teamusage` in a terminal. This stops automatic sending from this
machine. It does not delete anything on the server: your usage stays there until an operator runs
`remove-member` or `remove-machine`. The saved token stays in the client's config file until you delete it.

## What is counted and what is not

teamusage counts work that runs **on your own machine**, because that is where the usage logs are. Work
that runs on a provider's servers leaves no log on your machine and cannot be counted.

| How you work | Counted? |
| --- | --- |
| Claude Code in the terminal | Yes |
| Claude Code in the Claude desktop app, working in a folder on your machine | Yes |
| Claude Code in VS Code or JetBrains | Yes (it runs the same local Claude Code) |
| Scripts using the Claude Agent SDK on your machine | Yes |
| Codex, Gemini CLI, OpenCode, Copilot CLI and the other agents ccusage supports, run locally | Yes |
| Claude Code on the web (claude.ai/code) or any other session that runs in the cloud | **No** |
| Ordinary chat in the Claude app or on claude.ai | **No** |

If your team wants complete numbers:

- **Run coding sessions locally**: the terminal, the desktop app working on a local folder, or an IDE
  extension. Avoid cloud sessions for work that should be counted.
- **Use the machine where teamusage is set up.** Usage on a machine without it is not sent.
- **Let it sync at least once a month.** Claude Code deletes its local logs after 30 days by default, and
  usage that was never sent before then is lost. The plugin's hooks and the
  [scheduled sync](#scheduled-sync) take care of this.

All Claude Code sessions appear together under "Claude Code"; the dashboard does not separate the
terminal from the desktop app.

### Что учитывается, а что нет

teamusage считает только ту работу, которая выполняется **на вашем компьютере**: журналы использования
хранятся именно там. Сессии, которые выполняются на серверах провайдера, не оставляют журналов на
компьютере, и посчитать их нельзя.

| Как вы работаете | Учитывается? |
| --- | --- |
| Claude Code в терминале | Да |
| Claude Code в приложении Claude для компьютера, в локальной папке | Да |
| Claude Code в VS Code или JetBrains | Да |
| Скрипты на Claude Agent SDK на вашем компьютере | Да |
| Codex, Gemini CLI, OpenCode, Copilot CLI и другие агенты, запущенные локально | Да |
| Claude Code в браузере (claude.ai/code) и любые облачные сессии | **Нет** |
| Обычный чат в приложении Claude или на claude.ai | **Нет** |

Чтобы статистика была полной:

- **Запускайте сессии локально**: в терминале, в приложении для компьютера с локальной папкой или в
  расширении для IDE. Не используйте облачные сессии для работы, которую нужно учитывать.
- **Работайте на компьютере, где настроен teamusage.** С других компьютеров данные не отправляются.
- **Синхронизация должна проходить хотя бы раз в месяц.** Claude Code по умолчанию удаляет локальные
  журналы через 30 дней. Хуки плагина и синхронизация по расписанию делают это автоматически.

Тип аккаунта Claude (личный, team, enterprise или API-ключ) клиент определяет по локальному файлу
`.claude.json`, а аккаунта Codex (Личный · ChatGPT, Команда · ChatGPT, Enterprise · ChatGPT,
API-ключ · ChatGPT) по локальному файлу `auth.json`. Название организации отправляется только для team и
enterprise Claude, тариф (например, Premium) только если он распознан; почта, ID аккаунта и токены не
отправляются никогда. У записей Claude без метки в дашборде стоит «Неизвестно», у других агентов без
метки «Другие агенты», у записей без тарифа «Без тарифа».

## Exactly what is sent

For each day, agent and model, one record:

- date (your local day), agent, model
- input, output, cache-create and cache-read token counts, and their total
- estimated cost in US dollars, and a flag saying the model had no known price
- on Claude and Codex records dated your local today or yesterday (all days with `--label-history`), an
  account label: a kind (`personal`, `team`, `enterprise` or `api`) and, for Claude `team` and `enterprise`
  only, the organisation name (see [Account labels](#account-labels))
- the account's plan, when it is recognised: `free`, `pro`, `max_5x`, `max_20x`, `team_standard`,
  `team_premium`, `plus`, `business`, `edu` or `enterprise`. Nothing is sent for a plan that is not one of
  these

The server refuses a record with more than 10^12 tokens in any count or 4 × 10^12 in total, a cost above
$10,000,000, an agent name over 64 or a model name over 128 characters, or control characters in a name;
the client removes control characters, shortens longer names, and stops with an error on counts or costs
that large.

When a machine registers, once:

- your name and email
- a machine id: a hash derived from the operating system's machine identifier and your email. The raw
  identifier never leaves your machine. (On systems where none is available, a random value stored in
  your config takes its place.)
- the hostname, as a label. It is shown to the team on the member's page, together with the time of
  that machine's last sync.

Nothing else. Never your account email, account IDs, workspace IDs or tokens. No prompts, no file paths, no project or repository names, no session contents.
`teamusage sync --dry-run` prints the exact payload and sends nothing, so you can check for yourself.

From Claude Code's `~/.claude.json` the client reads only `oauthAccount.organizationType`,
`organizationName`, `seatTier` and `userRateLimitTier`. From Codex's `auth.json` it reads only whether
`OPENAI_API_KEY` is set (not its value) and the plan claim (`chatgpt_plan_type`) inside the login token;
no token, account id or email is read or sent.

Usage is read by [ccusage](https://github.com/ryoppippi/ccusage) (a pinned version) from each agent's
local logs. It supports several agents, for example Claude Code and Codex; see the ccusage project for
the full list. The cost is an estimate computed from public API prices. It is not what a subscription
plan charges you.

## Account labels

The dashboard can show which kind of account the usage ran on: an Accounts filter, an Accounts
column in the members table, and a "By account" breakdown on each member's page.

At each sync the client reads `oauthAccount.organizationType`, `organizationName`, `seatTier` and
`userRateLimitTier` from Claude Code's `.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that
variable is an absolute path, otherwise `~/.claude.json`) and reads nothing else from that file. For
Codex it reads `auth.json` in the Codex home (`$CODEX_HOME` when that is an absolute path, otherwise
`~/.codex`) and takes only whether `OPENAI_API_KEY` is a non-empty string and the `chatgpt_plan_type`
claim of the login token. The kinds:

- `personal`: Claude Pro, Max or Free; Codex with a Free, Plus or Pro ChatGPT login.
- `team` and `enterprise`: sent with the organisation name for Claude. For Codex, `team` is a Business
  (or "team") ChatGPT login, and `enterprise` is an Enterprise or Edu login.
- `api`: no login in the file but an API key, so the agent is using an API key.

If the file is missing or unreadable, or the account type is not one of these, no label is sent. A plan
that is not recognised is not sent either; nothing is guessed.

What the dashboard shows:

| Name | Meaning |
| --- | --- |
| Claude keys as before | Personal, Team (with organisation), Enterprise (with organisation), API key |
| Personal · ChatGPT, Team · ChatGPT, Enterprise · ChatGPT, API key · ChatGPT | Codex accounts |
| Unknown | Claude usage with no account label |
| Other agents | Usage of non-Claude agents with no account label |
| No plan | All usage without a recognised plan, including Unknown and Other agents |

The plan is appended to the name, for example "Team · Example Co · Premium" or "Personal · Max 5x".

The label is best effort and per day:

- Claude records dated your machine's local today or yesterday carry a label, and so do Codex records of
  those days. Older days, days sent by a 0.1.0 client, and other agents have none, and the dashboard shows
  "Unknown" (Claude) or "Other agents" for them.
- The server changes a day's label only when that day's tokens grow (or when the day has no label yet).
  A resend without a label never clears one.
- If you switch accounts during a day, that day keeps the label of the last sync that added tokens.

### Labelling past usage

`teamusage sync --label-history` sends all your history again and labels every Claude and Codex day with
the account you are logged in to now. It applies to this machine only, so run it on each machine. It is
your own statement that the current logins were used for all past usage, so run it once, and only if that
is true. It never overwrites a label that is already stored, and it fills in plans that are missing.
`--dry-run` previews it. It cannot be combined with `--detach` or `--throttle`. In Claude Code or Codex you
can say "label my history" («отметь мою историю») and the skill runs it for you.

## Security model and limits

Read this before you deploy. This version is deliberately simple.

- There are no passwords, roles or email verification. Anyone holding the invite code can register
  under any email, and can open the dashboard.
- Everyone on the team sees everyone's usage, machine names (hostnames) and last-sync times.
- Treat the invite code as a shared secret. An operator can remove a member or machine, and can rotate
  the invite code (which ends all dashboard sessions). Removing a member does not stop them from
  registering again while they still know the current code, so rotate it too. A removed machine that
  still has the current code (in the plugin's settings, or saved with `--save-invite`) registers again by
  itself on its next sync and sends its whole usage history again.
- Failed register and login attempts are limited to 10 per client address per 10 minutes. IPv6 clients
  are counted per /64 network, since one host usually holds a whole /64. The limiter tracks at most 10,000
  addresses at a time; when it is full, a new address is not limited (the invite code's length is what
  stops guessing), while addresses already tracked keep their limits.
- Dashboard sessions last 30 days.
- The server speaks plain HTTP. Use an HTTPS reverse proxy.
- The database file and its directory are private to the server's user (modes 600 and 700).
- Responses carry restrictive security headers (a strict content security policy, no framing, no
  sniffing), and the dashboard loads nothing from other origins.

## Scheduled sync

For agents that have no session hook, or if you do not use the plugins, a scheduled job runs `teamusage sync --quiet`
every four hours, and once when it is installed. It is installed only when you ask:

```sh
npm install -g teamusage          # the job needs a client that stays where it is
teamusage setup --schedule        # register and install it in one go
teamusage schedule install        # or install it on its own
teamusage schedule remove         # remove it again
teamusage status                  # shows "Scheduled sync: installed" or "not installed"
```

- **macOS:** a LaunchAgent at `~/Library/LaunchAgents/com.teamusage.sync.plist` (mode 0644), loaded with
  `launchctl`. `schedule remove` unloads it and deletes the file.
- **Linux:** one line in your crontab, tagged `# teamusage`. `schedule remove` deletes only that line.
- **Plugin users:** the job runs outside Claude Code, so it cannot see the plugin's settings. Run
  `teamusage setup` once with the same server address, name and email before `schedule install`;
  otherwise every scheduled run only logs `teamusage is not set up` in `sync.log`. If Claude Code is the
  only place you work, you do not need the job: the plugin's session hooks already send every agent
  ccusage finds on the machine, Codex included.
- **Windows is not supported yet.** `schedule install` says so and changes nothing.
- The job holds only the path of Node, the path of the installed client, `sync` and `--quiet`. Your name,
  email, server and invite code are never written into it; it reads the config file like any other sync.
- The client must be installed globally. Run from an `npx`, `pnpm dlx`, `bunx` or `yarn dlx` cache, or from a
  project's `node_modules`, `schedule install` refuses, because that path can disappear or move. It also refuses to run as root, and on paths containing `%` or a newline (cron cannot
  take them).
- **A custom config location is not supported.** launchd and cron do not pass on `XDG_CONFIG_HOME`, so the
  job could not find your config. If `XDG_CONFIG_HOME` points anywhere but `~/.config`, `schedule install`
  refuses; run `setup` without it first.
- The job records the paths of Node and of the client. After upgrading Node or moving the client, run
  `teamusage schedule install` again (it replaces the old job). `teamusage status` shows whether the
  schedule is healthy: `installed`, `installed but broken` (a recorded path is gone), `not installed`, or
  `unknown` (the crontab or plist could not be read).
- A failed scheduled sync prints nothing; look in `sync.log` in the config directory
  (`~/.config/teamusage`, or `$XDG_CONFIG_HOME/teamusage` when that variable is an absolute path).

## Codex

This repository is also a Codex plugin marketplace. The plugin sends your Codex usage automatically and
adds two skills and the MCP tools. It runs the client from npm at a pinned version
(`npx -y teamusage@0.3.0`), so Node.js 22 or newer is required. Set up once, in a terminal:

```sh
npx -y teamusage@0.3.0 setup                      # server URL, invite code, your name and email
codex plugin marketplace add imvityalee/teamusage
codex plugin add teamusage@teamusage
```

Then, in Codex, type `/hooks` and trust the teamusage hooks. Codex does not run hooks you have not
trusted. Trust them again after every plugin upgrade.

**Upgrading the plugin.** In a terminal, refresh the marketplace snapshot and install the new version:

```sh
codex plugin marketplace upgrade teamusage
codex plugin add teamusage@teamusage
```

Then, in Codex, type `/hooks` and trust the hooks again. If you registered teamusage with Codex before
(0.2.0 `setup` did that by default), run `codex mcp remove teamusage` first: that registration hides the
plugin's own MCP server.

`teamusage setup` no longer offers to register the MCP tools with Codex; when `codex` is on your `PATH`
it prints these plugin steps instead.

**When it sends.** The hooks start the sync in the background and never make Codex wait. Codex 0.141 has
no session-end event, so Codex usage is sent when a session starts and, during a session, at most every
4 hours after a reply. (The plugin also has a session-end hook, for later Codex versions.) The hooks work
on macOS and Linux. On Windows the hook commands are not valid, so Windows Codex users run
`teamusage sync` themselves or use the `sync_usage` MCP tool.

**Troubleshooting.** The hooks print nothing. To see what is wrong, run `npx -y teamusage@0.3.0 status`
or `teamusage sync` in a terminal, and read `sync.log` in the config directory.

**Without the plugin.** `teamusage setup --codex` registers only the MCP tools with Codex, by running

```sh
codex mcp add teamusage -- npx -y teamusage@<this client's version> mcp
```

It is for people who do not want the plugin, and it needs `codex` on `PATH`. `--no-codex` says nothing
about Codex. To undo it: `codex mcp remove teamusage`. You can also use the
[scheduled sync](#scheduled-sync) instead of hooks.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Needs Node.js 22 or newer and pnpm. The packages are `packages/server` (server and dashboard),
`packages/client` (the `teamusage` command) and `packages/shared`. The Claude Code plugin is in `plugin/`,
its marketplace file in `.claude-plugin/`, and `pnpm test` also runs `scripts/check-plugin.mjs` on them.

## Credits

The agent logos on the dashboard come from simple-icons 16.38.0 (https://simpleicons.org). simple-icons
publishes its icon files under CC0-1.0 (the GitHub Copilot icon under the MIT licence, reproduced in
`packages/server/web/public/agents/NOTICE.md`). That grants no trademark rights: the logos are trademarks
of their owners, used only to identify the products.

## Licence

MIT. See [LICENSE](LICENSE).
