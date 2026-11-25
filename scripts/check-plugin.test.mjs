// Tests for check-plugin.mjs: each rule is broken in a temporary copy of the plugin and must be reported.
// Run with: node --test scripts/check-plugin.test.mjs
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPlugin } from "./check-plugin.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh copy of the marketplaces, plugins, client package.json and root docs; `edit` breaks it. */
function copy(edit = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "check-plugin-"));
  temps.push(root);
  for (const dir of [".claude-plugin", "plugin", ".agents", "codex-plugin"]) {
    if (existsSync(path.join(repo, dir))) cpSync(path.join(repo, dir), path.join(root, dir), { recursive: true });
  }
  mkdirSync(path.join(root, "packages/client"), { recursive: true });
  cpSync(path.join(repo, "packages/client/package.json"), path.join(root, "packages/client/package.json"));
  for (const doc of ["README.md", "SELF-HOSTING.md"]) cpSync(path.join(repo, doc), path.join(root, doc));
  const file = (rel) => path.join(root, rel);
  const json = (rel, fn) => {
    const data = JSON.parse(readFileSync(file(rel), "utf8"));
    fn(data);
    writeFileSync(file(rel), JSON.stringify(data, null, 2));
  };
  const text = (rel, fn) => writeFileSync(file(rel), fn(readFileSync(file(rel), "utf8")));
  edit({ root, file, json, text });
  return checkPlugin(root);
}

const MANIFEST = "plugin/.claude-plugin/plugin.json";
const HOOKS = "plugin/hooks/hooks.json";
const MCP = "plugin/.mcp.json";
const SYNC_SKILL = "plugin/skills/usage-sync/SKILL.md";
const version = JSON.parse(readFileSync(path.join(repo, "packages/client/package.json"), "utf8")).version;

function expectFailure(failures, pattern) {
  assert.ok(failures.length > 0, "expected at least one failure");
  assert.ok(failures.some((f) => pattern.test(f)), `no failure matched ${pattern}:\n${failures.join("\n")}`);
}

test("the repository's plugin passes", () => assert.deepEqual(copy(), []));

test("a .DS_Store file is ignored, but any other unexpected file still fails", () => {
  assert.deepEqual(
    copy(({ file }) => {
      writeFileSync(file("plugin/.DS_Store"), "x");
      writeFileSync(file("plugin/skills/.DS_Store"), "x");
    }),
    [],
  );
  expectFailure(copy(({ file }) => writeFileSync(file("plugin/notes.txt"), "x")), /notes\.txt/);
});

test("a JSON file that does not parse", () =>
  expectFailure(copy(({ text }) => text(MANIFEST, (s) => s.replace("{", "{,"))), /plugin\.json: not valid JSON/));

test("a missing file", () => expectFailure(copy(({ file }) => rmSync(file(HOOKS))), /hooks\.json: missing/));

test("the plugin version differs from the client version", () =>
  expectFailure(copy(({ json }) => json("packages/client/package.json", (p) => (p.version = "9.9.9"))), /version .* differs/));

test("a hook runs another client version", () =>
  expectFailure(
    copy(({ json }) => json(HOOKS, (h) => (h.hooks.SessionEnd[0].hooks[0].args[1] = "teamusage@0.0.9"))),
    /teamusage@0\.0\.9 does not match/,
  ));

test("the MCP server runs teamusage@latest", () =>
  expectFailure(
    copy(({ json }) => json(MCP, (m) => (m.mcpServers.teamusage.args[1] = "teamusage@latest"))),
    /uses teamusage@latest/,
  ));

test("a version range instead of an exact version", () =>
  expectFailure(
    copy(({ json }) => json(MCP, (m) => (m.mcpServers.teamusage.args[1] = `teamusage@^${version}`))),
    /does not match the client version/,
  ));

test("an unpinned npx teamusage in a skill", () =>
  expectFailure(copy(({ text }) => text(SYNC_SKILL, (s) => `${s}\nRun \`npx teamusage sync\`.\n`)), /without a pinned version/));

test("an unpinned exec-form npx in the hooks", () =>
  expectFailure(
    copy(({ json }) => json(HOOKS, (h) => (h.hooks.SessionStart[0].hooks[0].args[1] = "teamusage"))),
    /npx runs teamusage instead of/,
  ));

test("a shell-form hook command", () =>
  expectFailure(
    copy(({ json }) =>
      json(HOOKS, (h) => {
        const hook = h.hooks.SessionEnd[0].hooks[0];
        delete hook.args;
        hook.command = "npx -y teamusage sync --quiet --detach";
      }),
    ),
    /SessionEnd hook must be/,
  ));

for (const key of ["server_url", "invite_code", "name", "email", "allow_insecure_http"]) {
  test(`userConfig.${key} is missing`, () =>
    expectFailure(copy(({ json }) => json(MANIFEST, (m) => delete m.userConfig[key])), new RegExp(`userConfig\\.${key} is missing`)));
}

test("invite_code is not sensitive", () =>
  expectFailure(
    copy(({ json }) => json(MANIFEST, (m) => delete m.userConfig.invite_code.sensitive)),
    /userConfig\.invite_code must be sensitive/,
  ));

test("allow_insecure_http defaults to true", () =>
  expectFailure(
    copy(({ json }) => json(MANIFEST, (m) => (m.userConfig.allow_insecure_http.default = true))),
    /allow_insecure_http must default to false/,
  ));

test("a hook on another event", () =>
  expectFailure(
    copy(({ json }) => json(HOOKS, (h) => (h.hooks.PreCompact = h.hooks.SessionEnd))),
    /hooks must be exactly SessionEnd, SessionStart and Stop/,
  ));

test("the SessionStart hook is missing", () =>
  expectFailure(copy(({ json }) => json(HOOKS, (h) => delete h.hooks.SessionStart)), /hooks must be exactly/));

test("a hook that is not async", () =>
  expectFailure(
    copy(({ json }) => json(HOOKS, (h) => (h.hooks.SessionStart[0].hooks[0].async = false))),
    /SessionStart hook must be/,
  ));

test("a hooks file without the top-level hooks key", () =>
  expectFailure(copy(({ json }) => json(HOOKS, (h) => Object.assign(h, h.hooks, { hooks: undefined }))), /top-level "hooks" key/));

test("user config interpolated into a hook argument", () =>
  expectFailure(
    copy(({ json }) => json(HOOKS, (h) => h.hooks.SessionEnd[0].hooks[0].args.push("${user_config.server_url}"))),
    /hooks\.json: \$\{user_config\.\*\} is allowed only/,
  ));

test("the invite code interpolated into a skill", () =>
  expectFailure(
    copy(({ text }) => text(SYNC_SKILL, (s) => `${s}\nThe code is \${user_config.invite_code}.\n`)),
    /SKILL\.md: \$\{user_config\.\*\} is allowed only/,
  ));

test("the MCP env takes a value from somewhere else", () =>
  expectFailure(
    copy(({ json }) => json(MCP, (m) => (m.mcpServers.teamusage.env.TEAMUSAGE_INVITE_CODE = "${INVITE}"))),
    /env must map exactly/,
  ));

test("a skill grants allowed-tools", () =>
  expectFailure(
    copy(({ text }) => text(SYNC_SKILL, (s) => s.replace("\n---\n", "\nallowed-tools: Bash\n---\n"))),
    /frontmatter must have exactly name and description/,
  ));

test("a skill without frontmatter", () =>
  expectFailure(copy(({ text }) => text(SYNC_SKILL, (s) => s.replace(/^---[\s\S]*?\n---\n/, ""))), /must start with a --- frontmatter/));

test("a skill name that does not match its directory", () =>
  expectFailure(copy(({ text }) => text(SYNC_SKILL, (s) => s.replace("name: usage-sync", "name: sync"))), /name must be "usage-sync"/));

test("a skill description with no Russian trigger phrases", () =>
  expectFailure(
    copy(({ text }) => text(SYNC_SKILL, (s) => s.replace(/^description: .*$/m, "description: Send usage."))),
    /needs Russian trigger phrases/,
  ));

test("a script in the plugin", () =>
  expectFailure(
    copy(({ file }) => writeFileSync(file("plugin/hooks/run.sh"), "#!/bin/sh\ncurl https://example.com\n")),
    /run\.sh: only \.json and \.md files/,
  ));

test("an executable file in the plugin", () =>
  expectFailure(copy(({ file }) => chmodSync(file(SYNC_SKILL), 0o755)), /SKILL\.md: must not be executable/));

test("the marketplace points at another source", () =>
  expectFailure(
    copy(({ json }) => json(".claude-plugin/marketplace.json", (m) => (m.plugins[0].source = "./other"))),
    /must list exactly one plugin/,
  ));

test("the client package ships more than dist", () =>
  expectFailure(
    copy(({ json }) => json("packages/client/package.json", (p) => (p.files = ["dist", "src"]))),
    /packages\/client\/package\.json: files must be exactly \["dist"\]/,
  ));

test("the client package has no files list", () =>
  expectFailure(
    copy(({ json }) => json("packages/client/package.json", (p) => delete p.files)),
    /packages\/client\/package\.json: files must be exactly \["dist"\]/,
  ));

test("the client package has no license", () =>
  expectFailure(
    copy(({ json }) => json("packages/client/package.json", (p) => delete p.license)),
    /packages\/client\/package\.json: needs a license/,
  ));

test("the README pins another client version", () =>
  expectFailure(
    copy(({ text }) => text("README.md", (s) => `${s}\nRun \`npx -y teamusage@0.0.9 sync\`.\n`)),
    /README\.md: teamusage@0\.0\.9 does not match the client version/,
  ));

test("SELF-HOSTING.md pins another client version", () =>
  expectFailure(
    copy(({ text }) => text("SELF-HOSTING.md", (s) => `${s}\nRun \`npx -y teamusage@0.0.9 sync\`.\n`)),
    /SELF-HOSTING\.md: teamusage@0\.0\.9 does not match the client version/,
  ));

test("the README pins a version range", () =>
  expectFailure(
    copy(({ text }) => text("README.md", (s) => `${s}\nRun \`npm install -g teamusage@^${version}\`.\n`)),
    /README\.md: teamusage@\^.* does not match the client version/,
  ));

test("the README is missing", () => expectFailure(copy(({ file }) => rmSync(file("README.md"))), /README\.md: missing/));

test("the Stop hook is missing", () =>
  expectFailure(copy(({ json }) => json(HOOKS, (h) => delete h.hooks.Stop)), /hooks must be exactly/));

test("the Stop hook lacks --throttle 4h", () =>
  expectFailure(
    copy(({ json }) => json(HOOKS, (h) => (h.hooks.Stop[0].hooks[0].args = ["-y", `teamusage@${version}`, "sync", "--quiet", "--detach"]))),
    /Stop hook must be/,
  ));

test("the Stop hook is not async", () =>
  expectFailure(copy(({ json }) => json(HOOKS, (h) => (h.hooks.Stop[0].hooks[0].async = false))), /Stop hook must be/));

test("SessionEnd must not carry --throttle", () =>
  expectFailure(
    copy(({ json }) => json(HOOKS, (h) => h.hooks.SessionEnd[0].hooks[0].args.push("--throttle", "4h"))),
    /SessionEnd hook must be/,
  ));

// The Codex plugin and its marketplace

const C_MANIFEST = "codex-plugin/.codex-plugin/plugin.json";
const C_HOOKS = "codex-plugin/hooks/hooks.json";
const C_MCP = "codex-plugin/.mcp.json";
const C_SYNC_SKILL = "codex-plugin/skills/usage-sync/SKILL.md";
const C_STATS_SKILL = "codex-plugin/skills/usage-stats/SKILL.md";
const C_MARKET = ".agents/plugins/marketplace.json";

test("the repository's Codex tree is checked: each of its files is required", () => {
  for (const f of [C_MANIFEST, C_HOOKS, C_MCP, C_SYNC_SKILL, C_STATS_SKILL, C_MARKET]) {
    expectFailure(copy(({ file }) => rmSync(file(f))), new RegExp(`${f.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: missing`));
  }
});

test("the Codex plugin version differs from the client version", () =>
  expectFailure(
    copy(({ json }) => json(C_MANIFEST, (m) => (m.version = "0.0.9"))),
    /codex-plugin\/\.codex-plugin\/plugin\.json: version 0\.0\.9 differs/,
  ));

test("the Codex manifest needs its name, skills path, licence and display name", () => {
  expectFailure(copy(({ json }) => json(C_MANIFEST, (m) => (m.name = "other"))), /codex-plugin\/\.codex-plugin\/plugin\.json: name must be "teamusage"/);
  expectFailure(copy(({ json }) => json(C_MANIFEST, (m) => (m.skills = "./other/"))), /plugin\.json: skills must be "\.\/skills\/"/);
  expectFailure(copy(({ json }) => json(C_MANIFEST, (m) => (m.license = "GPL-3.0"))), /plugin\.json: license must be "MIT"/);
  expectFailure(copy(({ json }) => json(C_MANIFEST, (m) => delete m.interface)), /plugin\.json: interface\.displayName must be "teamusage"/);
  expectFailure(copy(({ json }) => json(C_MANIFEST, (m) => delete m.author)), /plugin\.json: author\.name is missing/);
});

test("the Codex manifest must not point hooks or MCP at another file", () =>
  expectFailure(
    copy(({ json }) => json(C_MANIFEST, (m) => (m.hooks = "./other.json"))),
    /codex-plugin\/\.codex-plugin\/plugin\.json: must not declare "hooks"/,
  ));

test("a Codex hook pins another client version", () =>
  expectFailure(
    copy(({ json }) =>
      json(C_HOOKS, (h) => (h.hooks.SessionEnd[0].hooks[0].command = "npx -y teamusage@0.0.9 sync --quiet --detach")),
    ),
    /codex-plugin\/hooks\/hooks\.json: teamusage@0\.0\.9 does not match/,
  ));

test("a Codex skill pins another client version", () =>
  expectFailure(
    copy(({ text }) => text(C_SYNC_SKILL, (s) => `${s}\nRun \`npx -y teamusage@0.0.9 setup\`.\n`)),
    /codex-plugin\/skills\/usage-sync\/SKILL\.md: teamusage@0\.0\.9 does not match/,
  ));

test("the Codex Stop hook lacks --throttle 4h", () =>
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.Stop[0].hooks[0].command = `npx -y teamusage@${version} sync --quiet --detach`))),
    /codex-plugin\/hooks\/hooks\.json: Stop hook must be/,
  ));

test("the Codex hooks are exactly SessionStart, Stop and SessionEnd", () => {
  expectFailure(copy(({ json }) => json(C_HOOKS, (h) => delete h.hooks.SessionEnd)), /codex-plugin\/hooks\/hooks\.json: hooks must be exactly/);
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.UserPromptSubmit = h.hooks.Stop))),
    /codex-plugin\/hooks\/hooks\.json: hooks must be exactly/,
  );
});

test("a Codex hook in exec form, not one command string", () =>
  expectFailure(
    copy(({ json }) =>
      json(C_HOOKS, (h) => {
        const hook = h.hooks.SessionStart[0].hooks[0];
        hook.command = "npx";
        hook.args = ["-y", `teamusage@${version}`, "sync", "--quiet", "--detach"];
      }),
    ),
    /codex-plugin\/hooks\/hooks\.json: SessionStart hook must be/,
  ));

test("the Codex SessionStart hook without its matcher", () =>
  expectFailure(copy(({ json }) => json(C_HOOKS, (h) => delete h.hooks.SessionStart[0].matcher)), /SessionStart must match "startup\|resume"/));

// Codex 0.141 skips every hook marked async ("async hooks are not supported yet"), so none may be.
test("a Codex hook marked async", () => {
  for (const ev of ["SessionStart", "Stop"]) {
    expectFailure(
      copy(({ json }) => json(C_HOOKS, (h) => (h.hooks[ev][0].hooks[0].async = true))),
      new RegExp(`codex-plugin/hooks/hooks\\.json: ${ev} hook must be`),
    );
  }
});

test("the Codex SessionEnd hook carrying --throttle", () =>
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.SessionEnd[0].hooks[0].command += " --throttle 4h"))),
    /codex-plugin\/hooks\/hooks\.json: SessionEnd hook must be/,
  ));

test("the Codex MCP server with an env", () =>
  expectFailure(
    copy(({ json }) => json(C_MCP, (m) => (m.mcpServers.teamusage.env = { TEAMUSAGE_SERVER_URL: "https://usage.example.com" }))),
    /codex-plugin\/\.mcp\.json: must be exactly/,
  ));

test("the Codex MCP server runs another version", () =>
  expectFailure(
    copy(({ json }) => json(C_MCP, (m) => (m.mcpServers.teamusage.args[1] = "teamusage@0.0.9"))),
    /codex-plugin\/\.mcp\.json: must be exactly/,
  ));

test("a Codex skill without its front matter name", () =>
  expectFailure(
    copy(({ text }) => text(C_STATS_SKILL, (s) => s.replace("name: usage-stats\n", ""))),
    /codex-plugin\/skills\/usage-stats\/SKILL\.md: frontmatter must have exactly name and description/,
  ));

test("user config interpolated into a Codex file", () =>
  expectFailure(
    copy(({ text }) => text(C_SYNC_SKILL, (s) => `${s}\nThe server is \${user_config.server_url}.\n`)),
    /codex-plugin\/skills\/usage-sync\/SKILL\.md: \$\{user_config\.\*\} is allowed only/,
  ));

test("a script in the Codex plugin, or an extra skill file", () => {
  expectFailure(copy(({ file }) => writeFileSync(file("codex-plugin/hooks/run.sh"), "#!/bin/sh\n")), /codex-plugin\/hooks\/run\.sh: only \.json and \.md/);
  expectFailure(copy(({ file }) => writeFileSync(file("codex-plugin/skills/usage-sync/notes.md"), "x")), /notes\.md: unexpected file under codex-plugin\/skills/);
});

test("the Codex marketplace points at another source, or lacks its policy or category", () => {
  expectFailure(
    copy(({ json }) => json(C_MARKET, (m) => (m.plugins[0].source.path = "./plugin"))),
    /\.agents\/plugins\/marketplace\.json: must list exactly one plugin/,
  );
  expectFailure(
    copy(({ json }) => json(C_MARKET, (m) => (m.plugins[0].policy.installation = "INSTALLED_BY_DEFAULT"))),
    /\.agents\/plugins\/marketplace\.json: must list exactly one plugin/,
  );
  expectFailure(copy(({ json }) => json(C_MARKET, (m) => delete m.plugins[0].category)), /\.agents\/plugins\/marketplace\.json: must list exactly one plugin/);
  expectFailure(copy(({ json }) => json(C_MARKET, (m) => (m.name = "other"))), /\.agents\/plugins\/marketplace\.json: name must be "teamusage"/);
});

// Codex runs a hook's command through the user's login shell and waits for it to exit and for its stdout and
// stderr to close, so each hook runs under `sh -c` and backgrounds npx with its output redirected.
test("a Codex hook that runs in-line, or backgrounds without redirecting its output", () => {
  for (const command of [
    `npx -y teamusage@${version} sync --quiet --detach --throttle 4h`,
    `npx -y teamusage@${version} sync --quiet --detach --throttle 4h &`,
  ]) {
    expectFailure(
      copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.Stop[0].hooks[0].command = command))),
      /codex-plugin\/hooks\/hooks\.json: Stop hook must be/,
    );
  }
});

test("a Codex hook with a shell field, which Codex 0.141 does not read", () =>
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.SessionStart[0].hooks[0].shell = "bash"))),
    /codex-plugin\/hooks\/hooks\.json: SessionStart hook must be/,
  ));

test("every Codex hook backgrounds itself with its output redirected", () => {
  const hooks = JSON.parse(readFileSync(path.join(repo, C_HOOKS), "utf8")).hooks;
  for (const ev of ["SessionStart", "Stop", "SessionEnd"]) {
    assert.match(hooks[ev][0].hooks[0].command, /^sh -c '.* >\/dev\/null 2>&1 &'$/s, ev);
  }
});

// 0.3.1: each Codex hook tells the client it runs from Codex (so a setup problem leaves a notice), carries the
// label /hooks shows, and the Stop hook prints and removes the notice before it starts the sync.
const CODEX_STATUS = "teamusage: send usage";
const CODEX_NOTICE =
  'D=${XDG_CONFIG_HOME:-}; case "$D" in /*) ;; *) D="$HOME/.config";; esac; F="$D/teamusage/codex-notice.json"; ' +
  '[ -f "$F" ] && cat "$F" && rm -f "$F"; ';
const sh = (script) => `sh -c '${script}'`;
const BG = " >/dev/null 2>&1 &";
const sessionScript = () => `TEAMUSAGE_HOOK=codex npx -y teamusage@${version} sync --quiet --detach${BG}`;
const stopScript = () => `${CODEX_NOTICE}npx -y teamusage@${version} sync --quiet --detach --throttle 4h${BG}`;

test("the repository's Codex hooks are exactly the named, Codex-tagged commands", () => {
  const hooks = JSON.parse(readFileSync(path.join(repo, C_HOOKS), "utf8"));
  assert.deepEqual(hooks, {
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: sh(sessionScript()), statusMessage: CODEX_STATUS }] }],
      Stop: [{ hooks: [{ type: "command", command: sh(stopScript()), statusMessage: CODEX_STATUS }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: sh(sessionScript()), statusMessage: CODEX_STATUS }] }],
    },
  });
});

test("the 0.3.0 Codex hooks, without the Codex tag or the label, are rejected", () => {
  const old030 = {
    SessionStart: "npx -y teamusage@0.3.0 sync --quiet --detach >/dev/null 2>&1 &",
    Stop: "npx -y teamusage@0.3.0 sync --quiet --detach --throttle 4h >/dev/null 2>&1 &",
    SessionEnd: "npx -y teamusage@0.3.0 sync --quiet --detach >/dev/null 2>&1 &",
  };
  const failures = copy(({ json }) =>
    json(C_HOOKS, (h) => {
      for (const [ev, command] of Object.entries(old030)) h.hooks[ev][0].hooks[0] = { type: "command", command };
    }),
  );
  for (const ev of Object.keys(old030)) expectFailure(failures, new RegExp(`codex-plugin/hooks/hooks\\.json: ${ev} hook must be`));
  // The same commands at the current version, still without TEAMUSAGE_HOOK=codex
  for (const ev of ["SessionStart", "SessionEnd"]) {
    expectFailure(
      copy(({ json }) =>
        json(C_HOOKS, (h) => (h.hooks[ev][0].hooks[0].command = `npx -y teamusage@${version} sync --quiet --detach >/dev/null 2>&1 &`)),
      ),
      new RegExp(`codex-plugin/hooks/hooks\\.json: ${ev} hook must be`),
    );
  }
});

test("a Codex hook without its statusMessage, or with another one", () => {
  for (const ev of ["SessionStart", "Stop", "SessionEnd"]) {
    expectFailure(
      copy(({ json }) => json(C_HOOKS, (h) => delete h.hooks[ev][0].hooks[0].statusMessage)),
      new RegExp(`codex-plugin/hooks/hooks\\.json: ${ev} hook must be`),
    );
  }
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.Stop[0].hooks[0].statusMessage = "teamusage"))),
    /codex-plugin\/hooks\/hooks\.json: Stop hook must be/,
  );
});

test("the Codex Stop hook without the notice prefix, or a session hook with it", () => {
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.Stop[0].hooks[0].command = sh(stopScript().replace(CODEX_NOTICE, ""))))),
    /codex-plugin\/hooks\/hooks\.json: Stop hook must be/,
  );
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.SessionStart[0].hooks[0].command = sh(CODEX_NOTICE + sessionScript())))),
    /codex-plugin\/hooks\/hooks\.json: SessionStart hook must be/,
  );
});

test("the Stop hook's own sync must not set TEAMUSAGE_HOOK=codex (one warning per session)", () =>
  expectFailure(
    copy(({ json }) => json(C_HOOKS, (h) => (h.hooks.Stop[0].hooks[0].command = sh(stopScript().replace("npx -y", "TEAMUSAGE_HOOK=codex npx -y"))))),
    /codex-plugin\/hooks\/hooks\.json: Stop hook must be/,
  ));

test("Codex hooks without the sh -c wrapper, or with the relative-XDG-unsafe notice path", () => {
  for (const ev of ["SessionStart", "SessionEnd"]) {
    expectFailure(
      copy(({ json }) => json(C_HOOKS, (h) => (h.hooks[ev][0].hooks[0].command = sessionScript()))),
      new RegExp(`codex-plugin/hooks/hooks\\.json: ${ev} hook must be`),
    );
  }
  expectFailure(
    copy(({ json }) =>
      json(C_HOOKS, (h) => (h.hooks.Stop[0].hooks[0].command = sh(stopScript().replace(CODEX_NOTICE, 'F="${XDG_CONFIG_HOME:-$HOME/.config}/teamusage/codex-notice.json"; [ -f "$F" ] && cat "$F" && rm -f "$F"; ')))),
    ),
    /codex-plugin\/hooks\/hooks\.json: Stop hook must be/,
  );
});
