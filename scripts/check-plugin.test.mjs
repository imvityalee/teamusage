// Tests for check-plugin.mjs: each rule is broken in a temporary copy of the plugin and must be reported.
// Run with: node --test scripts/check-plugin.test.mjs
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPlugin } from "./check-plugin.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh copy of the marketplace, the plugin, the client package.json and the README; `edit` breaks it. */
function copy(edit = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "check-plugin-"));
  temps.push(root);
  cpSync(path.join(repo, ".claude-plugin"), path.join(root, ".claude-plugin"), { recursive: true });
  cpSync(path.join(repo, "plugin"), path.join(root, "plugin"), { recursive: true });
  mkdirSync(path.join(root, "packages/client"), { recursive: true });
  cpSync(path.join(repo, "packages/client/package.json"), path.join(root, "packages/client/package.json"));
  cpSync(path.join(repo, "README.md"), path.join(root, "README.md"));
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
    copy(({ json }) => json(HOOKS, (h) => (h.hooks.Stop = h.hooks.SessionEnd))),
    /hooks must be exactly SessionEnd and SessionStart/,
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

test("the README pins a version range", () =>
  expectFailure(
    copy(({ text }) => text("README.md", (s) => `${s}\nRun \`npm install -g teamusage@^${version}\`.\n`)),
    /README\.md: teamusage@\^.* does not match the client version/,
  ));

test("the README is missing", () => expectFailure(copy(({ file }) => rmSync(file("README.md"))), /README\.md: missing/));
