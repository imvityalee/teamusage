# Self-hosting teamusage

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

**To the multi-team release.** The server upgrades its database in place the first time it starts. The upgrade
is one-way: an older server started on the upgraded file fails on every registration, sign-in and upload, and going
back means restoring the backup. Back up `/data` first (see "Back up and move").
Existing members, machines, usage, invite code and signed-in browsers carry over; nobody has to set up again.

**From 0.3.0 to 0.3.1.** The server does not change; a 0.3.0 server is fine. 0.3.1 names the Codex hooks
("teamusage: send usage" in `/hooks`) and shows a warning in Codex when the hooks cannot send your usage
because of a setup problem. Members update the Claude Code plugin (see below), Codex users upgrade the Codex
plugin and trust its hooks again in `/hooks` (see [Codex](README.md#codex)), and anyone who installed the client
globally runs `npm install -g teamusage@0.3.1`.

**From 0.2.0 or older.** Upgrade the server first. Rebuild the image, run `docker rm -f teamusage`, and
start it again with the same `docker run` command and the same volume. Members, tokens and dashboard
sessions are kept. The first start with 0.3.0 or later adds columns to the usage table in place; there is
nothing for you to run.

Upgrade the server before the clients: an older server rejects uploads that carry Codex account labels.
Clients on 0.1.0 and 0.2.0 keep working against the new server. Their usage shows as "Unknown" in the
account views when they send no account label. After the server, members update the Claude Code plugin to
this release, which runs `teamusage@0.3.1`, and Codex users install the Codex plugin (see
[Codex](README.md#codex)). Anyone who installed the client globally runs `npm install -g teamusage@0.3.1`.

"Unknown" now means unlabelled Claude usage only. Usage of other agents without an account label shows
as "Other agents", and the `unknown` account filter matches Claude usage only.

To update the plugin, run `claude plugin update teamusage@teamusage` in your shell, or open `/plugin`,
select `teamusage` on the Installed tab and choose Update now. A third-party marketplace does not
auto-update by default. The running session keeps the old version until the next session or
`/reload-plugins`.

A 0.3.0 or newer client against a server older than 0.3.0: machines with a Codex login have every upload
refused until the server is upgraded. Nothing is lost; it is sent again after the upgrade. Claude-only
machines still upload, without plans.

An existing Codex MCP registration stays on the version it was registered with (0.2.0 `setup` registered
one by default). A registration like that also hides the plugin's own MCP server, so anyone who registered
teamusage with Codex before and now uses the plugin runs `codex mcp remove teamusage` first. People who do
not use the plugin re-run `teamusage setup --codex` to move the registration to 0.3.1. To upgrade the Codex
plugin, see [Codex](README.md#codex).

After upgrading, a member can give past days their plan and account label once: see
[Labelling past usage](README.md#labelling-past-usage).

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

If you set `TEAMUSAGE_PUBLIC_URL` to the address people open (see the settings below), the dashboard accepts
sign-in only from pages at that address. Scripts that sign in with `curl` then need `-H "Origin: <the address, without a trailing slash>"`.

### Server settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on inside the container. |
| `TEAMUSAGE_HOST` | `0.0.0.0` | Address to listen on. |
| `TEAMUSAGE_DATA_DIR` | `/data` | Where the database is kept. |
| `TEAMUSAGE_INVITE_CODE` | generated | The invite code, 16 to 128 characters, no spaces. |
| `TEAMUSAGE_TRUSTED_PROXIES` | `0` | How many reverse proxies are in front (0 to 10). |
| `TEAMUSAGE_PUBLIC_URL` | unset | The address people open, for example https://usage.example.com. When set, the dashboard accepts sign-in only from pages at this address, so another website cannot sign a visitor's browser in. Leave it unset if you are not sure of the address: sign-in then works as before. |
| `TEAMUSAGE_DEMO` | unset | `1` starts demo mode. The `--demo` flag does the same when you run `node dist/main.js` directly; with Docker, set `TEAMUSAGE_DEMO=1`, because arguments to `docker run` replace the command. |
| `TEAMUSAGE_MODE` | `self-hosted` | Leave unset. `hosted` runs the public multi-team service and needs more settings. |

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
