# teamusage

The command-line client for [teamusage](https://github.com/imvityalee/teamusage), a small self-hosted tool
that shows how much a team uses coding agents. This client reads your machine's local coding-agent usage
logs with [ccusage](https://github.com/ryoppippi/ccusage) and sends the token counts to your team's
teamusage server. The server, which you or your team run yourselves, is described in the
[repository README](https://github.com/imvityalee/teamusage#readme).

Requires Node.js 22 or newer. You need the server's address and the invite code from whoever runs it.

## Get started

```sh
npx teamusage setup
```

It asks for the server URL, the invite code (not echoed), your name and your email, registers this machine
and runs a first sync. The invite code is not stored unless you pass `--save-invite`. Avoid `--invite` on
the command line: it stays in shell history and is visible in process listings.

## Commands

```sh
teamusage setup             # register this machine, save the config, run the first sync
teamusage sync              # collect and upload now
teamusage sync --dry-run    # print exactly what would be sent; send nothing
teamusage sync --quiet      # print nothing, always exit 0; failures go to sync.log in the config directory
teamusage sync --detach     # run "sync --quiet" in the background and return at once
teamusage status            # config, last sync, and whether the server is reachable
teamusage stats             # your usage per model and the team total, last 30 days
teamusage stats --range 3m  # the same for the last 3 months (1m, 3m or 6m)
teamusage schedule install  # sync every 4 hours (macOS launchd or Linux cron); needs a global install
teamusage schedule remove   # remove that job
teamusage mcp               # serve the MCP tools sync_usage, get_my_usage and get_team_usage over stdio
```

`teamusage --help` lists every option. The scheduled job needs a client that stays where it is, so install
it globally first (`npm install -g teamusage`); `schedule install` refuses to run from an `npx` cache.

The config is saved at `~/.config/teamusage/config.json` (or `$XDG_CONFIG_HOME/teamusage/config.json` when
that variable is an absolute path), readable only by you. A saved token is bound to the server URL and email
it was issued for; if either changes, sync sends nothing until you run `teamusage setup` again.

## Exactly what is sent

For each day, agent and model, one record:

- date (your local day), agent, model
- input, output, cache-create and cache-read token counts, and their total
- estimated cost in US dollars, and a flag saying the model had no known price

The server accepts at most 10^12 tokens per count and 4 × 10^12 in total per record, at most
$10,000,000 per record, agent names of up to 64 and model names of up to 128 characters. The client removes
control characters from names and shortens longer ones; counts above the limits stop the sync with an error.

When a machine registers, once:

- your name and email
- a machine id: a hash derived from the operating system's machine identifier and your email. The raw
  identifier never leaves your machine. (On systems where none is available, a random value stored in your
  config takes its place.)
- the hostname, as a label

Nothing else. No prompts, no file paths, no project or repository names, no session contents.
`teamusage sync --dry-run` prints the exact payload and sends nothing, so you can check for yourself.
The cost is an estimate computed from public API prices, not what a subscription plan charges you.

## Plain HTTP

The client uses `https://` servers. It accepts plain `http://` only for `localhost` (and other loopback
addresses), unless you opt in with `teamusage setup --allow-insecure-http` or
`TEAMUSAGE_ALLOW_INSECURE_HTTP=1`; the token and invite code then travel unencrypted. Use HTTPS instead.

## Licence

MIT. See [LICENSE](LICENSE).
