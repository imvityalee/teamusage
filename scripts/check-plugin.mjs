#!/usr/bin/env node
// Checks the Claude Code and Codex plugins and their marketplace files. Prints one line per failure and exits 1 on any.
// Usage: node scripts/check-plugin.mjs [repo-root]   (default: the repository this script lives in)
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = "teamusage";
const USER_CONFIG = {
  server_url: { type: "string", required: true },
  invite_code: { type: "string", required: true, sensitive: true },
  name: { type: "string", required: true },
  email: { type: "string", required: true },
  allow_insecure_http: { type: "boolean", default: false },
};
const MCP_ENV = {
  TEAMUSAGE_SERVER_URL: "server_url",
  TEAMUSAGE_INVITE_CODE: "invite_code",
  TEAMUSAGE_NAME: "name",
  TEAMUSAGE_EMAIL: "email",
  TEAMUSAGE_ALLOW_INSECURE_HTTP: "allow_insecure_http",
};
const HOOK_EVENTS = ["SessionEnd", "SessionStart", "Stop"];
const STOP_ARGS = ["--throttle", "4h"];
const SESSION_START_MATCHER = "startup|resume";
// Codex 0.141 has no SessionEnd event (it ignores the key without a warning; OpenAI's hook docs list it for later
// versions) and skips every hook marked async ("async hooks are not supported yet"). It runs a hook's command string
// through the user's shell (`<shell> -c`, else `$SHELL -lc`) and waits until the shell exits and its stdout and
// stderr close, so each Codex hook backgrounds npx with its output redirected and returns at once.
const CODEX_BACKGROUND = " >/dev/null 2>&1 &";
const CODEX_POLICY = { installation: "AVAILABLE", authentication: "ON_INSTALL" };
const CODEX_CATEGORY = "Developer Tools";
const SKILLS = ["usage-stats", "usage-sync"];
const ALLOWED_EXT = new Set([".json", ".md"]);
const MAX_DESCRIPTION = 1536; // Claude Code truncates longer skill descriptions in its listing

function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".DS_Store") continue; // Finder litter: gitignored, so it can never ship
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

const sameArray = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Returns a list of failure messages for the plugin under `root`; empty means everything passed. */
export function checkPlugin(root) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const pluginDir = path.join(root, "plugin");

  let version;
  let clientPkg;
  try {
    clientPkg = JSON.parse(readFileSync(path.join(root, "packages/client/package.json"), "utf8"));
    version = clientPkg.version;
  } catch {
    fail("packages/client/package.json: cannot read the client version");
  }
  if (typeof version !== "string" || version === "") version = undefined;
  // The published package: only the bundle (npm adds package.json, README and LICENSE), under a licence.
  if (clientPkg !== undefined) {
    if (!sameArray(clientPkg.files, ["dist"])) fail('packages/client/package.json: files must be exactly ["dist"]');
    if (typeof clientPkg.license !== "string" || clientPkg.license === "") fail("packages/client/package.json: needs a license");
  }

  const pluginFiles = [...listFiles(pluginDir), ...listFiles(path.join(root, "codex-plugin"))];
  const files = [...listFiles(path.join(root, ".claude-plugin")), ...listFiles(path.join(root, ".agents/plugins")), ...pluginFiles];
  const json = new Map();
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    try {
      json.set(rel(f), JSON.parse(readFileSync(f, "utf8")));
    } catch {
      fail(`${rel(f)}: not valid JSON`);
    }
  }
  const need = (name) => {
    if (!files.some((f) => rel(f) === name)) fail(`${name}: missing`);
    return json.get(name);
  };

  // Marketplace
  const market = need(".claude-plugin/marketplace.json");
  if (market) {
    if (market.name !== PLUGIN) fail(`.claude-plugin/marketplace.json: name must be "${PLUGIN}"`);
    if (typeof market.owner?.name !== "string" || market.owner.name === "") {
      fail(".claude-plugin/marketplace.json: owner.name is missing");
    }
    const entries = Array.isArray(market.plugins) ? market.plugins : [];
    if (entries.length !== 1 || entries[0]?.name !== PLUGIN || entries[0]?.source !== "./plugin") {
      fail(`.claude-plugin/marketplace.json: must list exactly one plugin {name: "${PLUGIN}", source: "./plugin"}`);
    }
  }

  // Manifest
  const manifest = need("plugin/.claude-plugin/plugin.json");
  if (manifest) {
    if (manifest.name !== PLUGIN) fail(`plugin/.claude-plugin/plugin.json: name must be "${PLUGIN}"`);
    if (version !== undefined && manifest.version !== version) {
      fail(`plugin/.claude-plugin/plugin.json: version ${manifest.version} differs from the client version ${version}`);
    }
    const uc = manifest.userConfig ?? {};
    for (const [key, spec] of Object.entries(USER_CONFIG)) {
      const o = uc[key];
      if (typeof o !== "object" || o === null) {
        fail(`plugin/.claude-plugin/plugin.json: userConfig.${key} is missing`);
        continue;
      }
      if (o.type !== spec.type) fail(`plugin/.claude-plugin/plugin.json: userConfig.${key} must have type ${spec.type}`);
      for (const f of ["title", "description"]) {
        if (typeof o[f] !== "string" || o[f] === "") fail(`plugin/.claude-plugin/plugin.json: userConfig.${key} needs a ${f}`);
      }
      if ((o.required === true) !== (spec.required === true)) {
        fail(`plugin/.claude-plugin/plugin.json: userConfig.${key} must ${spec.required ? "" : "not "}be required`);
      }
      if ((o.sensitive === true) !== (spec.sensitive === true)) {
        fail(`plugin/.claude-plugin/plugin.json: userConfig.${key} must ${spec.sensitive ? "" : "not "}be sensitive`);
      }
      if ("default" in spec && o.default !== spec.default) {
        fail(`plugin/.claude-plugin/plugin.json: userConfig.${key} must default to ${spec.default}`);
      }
    }
    for (const key of Object.keys(uc)) {
      if (!(key in USER_CONFIG)) fail(`plugin/.claude-plugin/plugin.json: unexpected userConfig.${key}`);
    }
    for (const k of ["hooks", "mcpServers", "commands", "agents", "skills", "lspServers", "outputStyles", "experimental"]) {
      if (k in manifest) fail(`plugin/.claude-plugin/plugin.json: must not declare "${k}"; use the default locations`);
    }
  }

  const clientArgs = (...rest) => ["-y", `${PLUGIN}@${version}`, ...rest];

  // MCP server
  const mcp = need("plugin/.mcp.json");
  if (mcp) {
    const servers = mcp.mcpServers ?? {};
    const names = Object.keys(servers);
    const s = servers[PLUGIN];
    if (names.length !== 1 || !s) {
      fail(`plugin/.mcp.json: must declare exactly one server "${PLUGIN}"`);
    } else {
      if (s.command !== "npx" || !sameArray(s.args, clientArgs("mcp"))) {
        fail(`plugin/.mcp.json: server must run npx ${clientArgs("mcp").join(" ")}`);
      }
      const env = s.env ?? {};
      const want = Object.entries(MCP_ENV);
      if (Object.keys(env).length !== want.length || want.some(([k, opt]) => env[k] !== `\${user_config.${opt}}`)) {
        fail(`plugin/.mcp.json: env must map exactly ${want.map(([k, o]) => `${k}=\${user_config.${o}}`).join(", ")}`);
      }
    }
  }

  // Hooks
  const hooksFile = need("plugin/hooks/hooks.json");
  if (hooksFile) {
    const events = hooksFile.hooks;
    if (typeof events !== "object" || events === null || Array.isArray(events)) {
      fail('plugin/hooks/hooks.json: the event map must sit under a top-level "hooks" key');
    } else {
      if (!sameArray(Object.keys(events).sort(), HOOK_EVENTS)) {
        fail(`plugin/hooks/hooks.json: hooks must be exactly ${HOOK_EVENTS.slice(0, -1).join(", ")} and ${HOOK_EVENTS.at(-1)}`);
      }
      for (const ev of Object.keys(events)) {
        const want = clientArgs("sync", "--quiet", "--detach", ...(ev === "Stop" ? STOP_ARGS : []));
        const handlers = (Array.isArray(events[ev]) ? events[ev] : []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [null]));
        if (handlers.length !== 1) fail(`plugin/hooks/hooks.json: ${ev} must have exactly one hook`);
        for (const h of handlers) {
          const ok = h?.type === "command" && h.command === "npx" && sameArray(h.args, want) && h.async === true;
          if (!ok) fail(`plugin/hooks/hooks.json: ${ev} hook must be {type: "command", command: "npx", args: ${JSON.stringify(want)}, async: true}`);
        }
      }
    }
  }

  // Codex marketplace
  const codexMarket = need(".agents/plugins/marketplace.json");
  if (codexMarket) {
    const M = ".agents/plugins/marketplace.json";
    if (codexMarket.name !== PLUGIN) fail(`${M}: name must be "${PLUGIN}"`);
    const entries = Array.isArray(codexMarket.plugins) ? codexMarket.plugins : [];
    const e = entries[0];
    const ok =
      entries.length === 1 &&
      e?.name === PLUGIN &&
      e.source?.source === "local" &&
      e.source?.path === "./codex-plugin" &&
      e.policy?.installation === CODEX_POLICY.installation &&
      e.policy?.authentication === CODEX_POLICY.authentication &&
      e.category === CODEX_CATEGORY;
    if (!ok) {
      fail(
        `${M}: must list exactly one plugin {name: "${PLUGIN}", source: {source: "local", path: "./codex-plugin"}, ` +
          `policy: ${JSON.stringify(CODEX_POLICY)}, category: "${CODEX_CATEGORY}"}`,
      );
    }
  }

  // Codex manifest
  const C_MANIFEST = "codex-plugin/.codex-plugin/plugin.json";
  const cManifest = need(C_MANIFEST);
  if (cManifest) {
    if (cManifest.name !== PLUGIN) fail(`${C_MANIFEST}: name must be "${PLUGIN}"`);
    if (version !== undefined && cManifest.version !== version) {
      fail(`${C_MANIFEST}: version ${cManifest.version} differs from the client version ${version}`);
    }
    for (const k of ["description", "repository"]) {
      if (typeof cManifest[k] !== "string" || cManifest[k] === "") fail(`${C_MANIFEST}: ${k} is missing`);
    }
    if (typeof cManifest.author?.name !== "string" || cManifest.author.name === "") fail(`${C_MANIFEST}: author.name is missing`);
    if (cManifest.license !== "MIT") fail(`${C_MANIFEST}: license must be "MIT"`);
    const kw = cManifest.keywords;
    if (!Array.isArray(kw) || kw.length === 0 || !kw.every((k) => typeof k === "string" && k !== "")) {
      fail(`${C_MANIFEST}: keywords must be a list of words`);
    }
    if (cManifest.skills !== "./skills/") fail(`${C_MANIFEST}: skills must be "./skills/"`);
    if (cManifest.interface?.displayName !== PLUGIN) fail(`${C_MANIFEST}: interface.displayName must be "${PLUGIN}"`);
    // Codex reads hooks/hooks.json and .mcp.json by default; a path here would add a second source.
    for (const k of ["hooks", "mcpServers", "apps"]) {
      if (k in cManifest) fail(`${C_MANIFEST}: must not declare "${k}"; use the default locations`);
    }
  }

  // Codex MCP server: no env, the client reads its own config file
  const C_MCP = "codex-plugin/.mcp.json";
  const cMcp = need(C_MCP);
  if (cMcp) {
    const want = { mcpServers: { [PLUGIN]: { command: "npx", args: clientArgs("mcp") } } };
    if (JSON.stringify(cMcp) !== JSON.stringify(want)) fail(`${C_MCP}: must be exactly ${JSON.stringify(want)}`);
  }

  // Codex hooks: one command string each, backgrounded in the shell
  const C_HOOKS = "codex-plugin/hooks/hooks.json";
  const cHooks = need(C_HOOKS);
  if (cHooks) {
    const events = cHooks.hooks;
    if (typeof events !== "object" || events === null || Array.isArray(events)) {
      fail(`${C_HOOKS}: the event map must sit under a top-level "hooks" key`);
    } else {
      if (!sameArray(Object.keys(events).sort(), HOOK_EVENTS)) {
        fail(`${C_HOOKS}: hooks must be exactly ${HOOK_EVENTS.slice(0, -1).join(", ")} and ${HOOK_EVENTS.at(-1)}`);
      }
      for (const ev of Object.keys(events)) {
        const groups = Array.isArray(events[ev]) ? events[ev] : [];
        if (ev === "SessionStart" && (groups.length !== 1 || groups[0]?.matcher !== SESSION_START_MATCHER)) {
          fail(`${C_HOOKS}: SessionStart must match "${SESSION_START_MATCHER}"`);
        }
        const handlers = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [null]));
        if (handlers.length !== 1) fail(`${C_HOOKS}: ${ev} must have exactly one hook`);
        const args = clientArgs("sync", "--quiet", "--detach", ...(ev === "Stop" ? STOP_ARGS : []));
        const want = { type: "command", command: ["npx", ...args].join(" ") + CODEX_BACKGROUND };
        for (const h of handlers) {
          if (JSON.stringify(h) !== JSON.stringify(want)) fail(`${C_HOOKS}: ${ev} hook must be ${JSON.stringify(want)}`);
        }
      }
    }
  }

  // Skills of both plugins
  for (const [dir, name] of ["plugin", "codex-plugin"].flatMap((d) => SKILLS.map((s) => [d, s]))) {
    const file = `${dir}/skills/${name}/SKILL.md`;
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      fail(`${file}: missing`);
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!m) {
      fail(`${file}: must start with a --- frontmatter block`);
      continue;
    }
    const fields = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]] = kv[2].trim();
      else if (line.trim() !== "") fail(`${file}: frontmatter must be single-line "key: value" entries`);
    }
    const keys = Object.keys(fields).sort();
    if (!sameArray(keys, ["description", "name"])) fail(`${file}: frontmatter must have exactly name and description`);
    if (fields.name !== name) fail(`${file}: frontmatter name must be "${name}"`);
    if (!fields.description) fail(`${file}: frontmatter description is empty`);
    else if (fields.description.length > MAX_DESCRIPTION) fail(`${file}: description is longer than ${MAX_DESCRIPTION} characters`);
    if (!/[а-яё]/i.test(fields.description ?? "")) fail(`${file}: description needs Russian trigger phrases`);
    if (text.slice(m[0].length).trim() === "") fail(`${file}: body is empty`);
  }
  for (const f of pluginFiles) {
    const r = rel(f);
    const dir = ["plugin", "codex-plugin"].find((d) => r.startsWith(`${d}/skills/`));
    if (dir && !SKILLS.some((s) => r === `${dir}/skills/${s}/SKILL.md`)) fail(`${r}: unexpected file under ${dir}/skills`);
  }

  // Every file in both plugins: no scripts, pinned client only, user config only in the MCP env
  for (const f of pluginFiles) {
    const r = rel(f);
    if (!ALLOWED_EXT.has(path.extname(f))) fail(`${r}: only .json and .md files are allowed in a plugin`);
    if ((statSync(f).mode & 0o111) !== 0) fail(`${r}: must not be executable`);
    const text = readFileSync(f, "utf8");
    if (r !== "plugin/.mcp.json" && text.includes("${user_config.")) {
      fail(`${r}: \${user_config.*} is allowed only in plugin/.mcp.json`);
    }
    if (/teamusage@latest/.test(text)) fail(`${r}: uses teamusage@latest`);
    for (const pin of text.matchAll(/teamusage@([^\s"'`,\])}]+)/g)) {
      if (pin[1] !== version && pin[1] !== PLUGIN && pin[1] !== "latest") {
        fail(`${r}: teamusage@${pin[1]} does not match the client version ${version}`);
      }
    }
    if (/\bnpx(\s+-[-\w]+)*\s+teamusage(?!@)/.test(text)) fail(`${r}: runs npx teamusage without a pinned version`);
    // Exec-form entries split "npx" and "teamusage@X" into separate JSON strings; join them to check the same rule.
    if (json.has(r)) {
      const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (typeof v !== "object" || v === null) return;
        if (v.command === "npx" && Array.isArray(v.args)) {
          const pkg = v.args.find((a) => typeof a === "string" && !a.startsWith("-"));
          if (pkg !== `${PLUGIN}@${version}`) fail(`${r}: npx runs ${pkg ?? "nothing"} instead of ${PLUGIN}@${version}`);
        } else if (typeof v.command === "string" && /\bnpx\b/.test(v.command) && !v.command.includes(`${PLUGIN}@${version}`)) {
          fail(`${r}: npx command does not run ${PLUGIN}@${version}`);
        }
        Object.values(v).forEach(walk);
      };
      walk(json.get(r));
    }
  }

  // The root README: every pinned client version (teamusage@1.2.3, or a range such as teamusage@^1.2.3) must be
  // the client version. teamusage@teamusage names the plugin, not a version, and is not checked.
  let readme;
  try {
    readme = readFileSync(path.join(root, "README.md"), "utf8");
  } catch {
    fail("README.md: missing");
  }
  if (readme !== undefined && version !== undefined) {
    for (const pin of readme.matchAll(/teamusage@([~^<>=]*\d[^\s"'`,\])}]*)/g)) {
      if (pin[1] !== version) fail(`README.md: teamusage@${pin[1]} does not match the client version ${version}`);
    }
  }

  return failures;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const failures = checkPlugin(root);
  for (const f of failures) process.stdout.write(`check-plugin: ${f}\n`);
  if (failures.length > 0) process.exit(1);
  process.stdout.write("check-plugin: ok\n");
}
