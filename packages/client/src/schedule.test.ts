import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { cronLine, installSchedule, launchdPlist, mergeCrontab, removeFromCrontab, removeSchedule, scheduleStatus, unstableLocation, parseCronLine, parsePlist, type RunResult, type ScheduleDeps } from "./schedule.js";

const NODE = "/usr/local/bin/node";
const CLI = "/usr/local/lib/node_modules/teamusage/dist/cli.js";
const TAGGED = `17 */4 * * * '${NODE}' '${CLI}' sync --quiet # teamusage`;
const OLD = "17 */4 * * * '/old/node' '/old/cli.js' sync --quiet # teamusage";
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

function fake(over: Partial<ScheduleDeps> & { crontab?: string; crontabExists?: boolean } = {}) {
  const files = new Map<string, { data: string; mode: number }>();
  const calls: { file: string; args: string[]; input?: string }[] = [];
  let crontab = over.crontab ?? "";
  let crontabExists = over.crontabExists ?? over.crontab !== undefined;
  let loaded = false;
  const deps: ScheduleDeps = {
    run: async (file, args, input) => {
      calls.push({ file, args, ...(input === undefined ? {} : { input }) });
      if (file === "launchctl") {
        if (args[0] === "bootstrap" || args[0] === "load") loaded = true;
        if (args[0] === "bootout" || args[0] === "unload") loaded = false;
        if (args[0] === "print") return loaded ? ok() : { code: 113, stdout: "", stderr: "not found" };
      }
      if (file === "crontab" && args[0] === "-l") {
        return crontabExists ? ok(crontab) : { code: 1, stdout: "", stderr: "no crontab for me\n" };
      }
      if (file === "crontab" && args[0] === "-") {
        crontab = input ?? "";
        crontabExists = true;
      }
      if (file === "crontab" && args[0] === "-r") crontabExists = false;
      return ok();
    },
    readFile: (f) => files.get(f)?.data,
    writeFile: (f, data, mode) => void files.set(f, { data, mode }),
    rm: (f) => void files.delete(f),
    exists: () => true,
    env: {},
    homedir: () => "/Users/ann",
    uid: () => 501,
    nodePath: NODE,
    cliPath: () => CLI,
    ...over,
  };
  return { deps, files, calls, crontab: () => crontab, exists: () => crontabExists, setLoaded: () => void (loaded = true) };
}

describe("launchdPlist", () => {
  test("is the expected XML with the label, both paths, sync and --quiet", () => {
    const p = launchdPlist({ nodePath: NODE, cliPath: CLI });
    expect(p).toContain("<string>com.teamusage.sync</string>");
    expect(p).toContain(`<string>${NODE}</string>`);
    expect(p).toContain(`<string>${CLI}</string>`);
    expect(p).toContain("<string>sync</string>");
    expect(p).toContain("<string>--quiet</string>");
    expect(p).toMatch(/<key>StartInterval<\/key>\s*<integer>14400<\/integer>/);
    expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test("XML-escapes a path with & < > quote and apostrophe", () => {
    const p = launchdPlist({ nodePath: NODE, cliPath: `/Users/a & b/it's <x> "y"/cli.js` });
    expect(p).toContain("<string>/Users/a &amp; b/it&apos;s &lt;x&gt; &quot;y&quot;/cli.js</string>");
    expect(p).not.toContain("a & b");
  });

  test("refuses a path with a control character", () => {
    expect(() => launchdPlist({ nodePath: NODE, cliPath: "/a\nb" })).toThrow(/control/);
  });

  test("passes plutil -lint when written to a temp directory", () => {
    if (process.platform !== "darwin") return;
    const dir = mkdtempSync(path.join(tmpdir(), "teamusage-plist-"));
    try {
      const f = path.join(dir, "a.plist");
      execFileSync("sh", ["-c", 'printf "%s" "$1" > "$2"', "sh", launchdPlist({ nodePath: NODE, cliPath: `/Users/a & b/it's/cli.js` }), f]);
      execFileSync("plutil", ["-lint", f]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("cronLine", () => {
  test("has the expected format, with both paths single-quoted", () => {
    expect(cronLine({ nodePath: NODE, cliPath: CLI })).toBe(TAGGED);
  });

  test("single-quotes paths so spaces, ampersands and apostrophes cannot break out", () => {
    const l = cronLine({ nodePath: NODE, cliPath: "/Users/a b & c/it's; rm -rf ~/cli.js" });
    expect(l).toContain(`'/Users/a b & c/it'\\''s; rm -rf ~/cli.js'`);
    // run through a real shell, with echo standing in for node: the quoted path is one argument
    const cmd = l.replace(/^17 \*\/4 \* \* \* /, "").replace(/ # teamusage$/, "").replace(`'${NODE}'`, "printf '[%s]'");
    expect(execFileSync("sh", ["-c", cmd]).toString()).toBe("[/Users/a b & c/it's; rm -rf ~/cli.js][sync][--quiet]");
  });

  test("refuses a newline or a percent sign in either path", () => {
    expect(() => cronLine({ nodePath: NODE, cliPath: "/a\nb" })).toThrow();
    expect(() => cronLine({ nodePath: NODE, cliPath: "/a\rb" })).toThrow();
    expect(() => cronLine({ nodePath: NODE, cliPath: "/100%/cli.js" })).toThrow(/%/);
    expect(() => cronLine({ nodePath: "/n%/node", cliPath: CLI })).toThrow(/%/);
  });
});

describe("mergeCrontab", () => {
  test("adds one line to an empty crontab", () => {
    expect(mergeCrontab("", TAGGED)).toBe(`${TAGGED}\n`);
  });

  test("replaces an old teamusage line in place and keeps every other line and its order", () => {
    const before = `# my jobs\n0 1 * * * backup\n${OLD}\n30 2 * * * other\n`;
    expect(mergeCrontab(before, TAGGED)).toBe(`# my jobs\n0 1 * * * backup\n${TAGGED}\n30 2 * * * other\n`);
  });

  test("is idempotent", () => {
    const once = mergeCrontab("0 1 * * * backup\n", TAGGED);
    expect(mergeCrontab(once, TAGGED)).toBe(once);
  });

  test("always ends with exactly one newline, even if the old text had none or several", () => {
    expect(mergeCrontab("0 1 * * * backup", TAGGED)).toBe(`0 1 * * * backup\n${TAGGED}\n`);
    expect(mergeCrontab("0 1 * * * backup\n\n", TAGGED)).toBe(`0 1 * * * backup\n\n${TAGGED}\n`);
  });

  test("a user's own line ending in the tag, or a commented-out one, is never replaced", () => {
    const before = "0 1 * * * backup # teamusage\n# 17 */4 * * * '/n' '/c' sync --quiet # teamusage\n  # " + OLD + "\n";
    const merged = mergeCrontab(before, TAGGED);
    expect(merged).toBe(`${before}${TAGGED}\n`);
    expect(removeFromCrontab(merged)).toBe(before);
  });

  test("duplicate tagged lines collapse into one, in the place of the first", () => {
    expect(mergeCrontab(`${OLD}\nx\n${OLD}\n`, TAGGED)).toBe(`${TAGGED}\nx\n`);
  });

  test("CRLF crontab: matches with the \\r ignored, keeps other endings, writes ours with the prevailing one", () => {
    const base = "0 1 * * * backup\r\n# note\r\n";
    const once = mergeCrontab(base, TAGGED);
    expect(once).toBe(`${base}${TAGGED}\r\n`);
    expect(mergeCrontab(once, TAGGED)).toBe(once);
    expect(once.split("\n").filter((l) => l.includes("# teamusage"))).toHaveLength(1);
    expect(removeFromCrontab(once)).toBe(base);
    // a mixed file keeps each untouched line's own ending
    expect(mergeCrontab("a\nb\r\n", TAGGED)).toBe(`a\nb\r\n${TAGGED}\n`);
  });

  test("refuses a line that is not tagged or has a newline", () => {
    expect(() => mergeCrontab("", "17 * * * * x")).toThrow();
    expect(() => mergeCrontab("", `x\ny ${"# teamusage"}`)).toThrow();
  });
});

describe("removeFromCrontab", () => {
  test("removes only the tagged line and leaves everything else byte for byte", () => {
    expect(removeFromCrontab(`a\n\n  b  \n${TAGGED}\nc`)).toBe("a\n\n  b  \nc\n"); // always newline-terminated
    expect(removeFromCrontab(`a\n${TAGGED}\nc\n`)).toBe("a\nc\n");
  });
  test("returns null when there is nothing to remove, and empty when nothing is left", () => {
    expect(removeFromCrontab("a\nb\n")).toBeNull();
    expect(removeFromCrontab(`${TAGGED}\n`)).toBe("");
  });
});

describe("installSchedule / removeSchedule", () => {
  test("win32 is refused, mentioning Windows is not supported yet, and nothing runs or is written", async () => {
    const f = fake();
    await expect(installSchedule("win32", f.deps)).rejects.toThrow(/Windows is not supported yet/);
    await expect(removeSchedule("win32", f.deps)).rejects.toThrow(/Windows is not supported yet/);
    expect(f.calls).toEqual([]);
    expect(f.files.size).toBe(0);
  });

  test("refuses to run as root", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const f = fake({ uid: () => 0 });
      await expect(installSchedule(platform, f.deps)).rejects.toThrow(/root/);
      expect(f.calls).toEqual([]);
      expect(f.files.size).toBe(0);
    }
  });

  test("refuses to install from an npx cache, on both path styles", async () => {
    for (const cli of ["/Users/ann/.npm/_npx/abc123/node_modules/teamusage/dist/cli.js", "C:\\Users\\ann\\_npx\\abc\\cli.js"]) {
      const f = fake({ cliPath: () => cli });
      await expect(installSchedule("darwin", f.deps)).rejects.toThrow(/npm install -g teamusage/);
      expect(f.calls).toEqual([]);
      expect(f.files.size).toBe(0);
    }
  });

  test("macOS: writes the plist (0644) in LaunchAgents, then bootstraps it with an argument array", async () => {
    const f = fake();
    const msg = await installSchedule("darwin", f.deps);
    const file = "/Users/ann/Library/LaunchAgents/com.teamusage.sync.plist";
    expect(f.files.get(file)?.mode).toBe(0o644);
    expect(f.files.get(file)?.data).toBe(launchdPlist({ nodePath: NODE, cliPath: CLI }));
    expect(f.calls.at(-1)).toEqual({ file: "launchctl", args: ["bootstrap", "gui/501", file] });
    expect(msg).toContain(file);
  });

  test("macOS: replaces an existing job by booting the old one out first", async () => {
    const f = fake();
    const file = "/Users/ann/Library/LaunchAgents/com.teamusage.sync.plist";
    f.files.set(file, { data: "old", mode: 0o644 });
    await installSchedule("darwin", f.deps);
    expect(f.calls[0]).toEqual({ file: "launchctl", args: ["bootout", "gui/501/com.teamusage.sync"] });
    expect(f.files.get(file)?.data).toContain("--quiet");
  });

  test("macOS: falls back to launchctl load -w when bootstrap fails, and cleans up when both fail", async () => {
    const run = vi.fn(async (_f: string, args: string[]) => (args[0] === "bootstrap" ? { code: 1, stdout: "", stderr: "x" } : ok()));
    const f = fake({ run });
    await installSchedule("darwin", f.deps);
    expect(run).toHaveBeenLastCalledWith("launchctl", ["load", "-w", "/Users/ann/Library/LaunchAgents/com.teamusage.sync.plist"]);
    const g = fake({ run: async (_f, args) => (args[0] === "bootout" ? ok() : { code: 1, stdout: "", stderr: "x" }) });
    await expect(installSchedule("darwin", g.deps)).rejects.toThrow(/launchctl/);
    expect(g.files.size).toBe(0);
  });

  test("macOS: a home directory with a space, ampersand and apostrophe gives a valid, escaped plist and untouched argv", async () => {
    const home = "/Users/Ann & Bob's Home";
    const f = fake({ homedir: () => home, cliPath: () => `${home}/lib/cli.js` });
    await installSchedule("darwin", f.deps);
    const file = `${home}/Library/LaunchAgents/com.teamusage.sync.plist`;
    expect(f.files.get(file)?.data).toContain("Ann &amp; Bob&apos;s Home/lib/cli.js");
    expect(f.calls.at(-1)?.args).toEqual(["bootstrap", "gui/501", file]);
  });

  test("macOS: remove boots the job out and deletes the file; a missing job is not an error", async () => {
    const f = fake();
    const file = "/Users/ann/Library/LaunchAgents/com.teamusage.sync.plist";
    f.files.set(file, { data: "x", mode: 0o644 });
    await removeSchedule("darwin", f.deps);
    expect(f.calls[0]).toEqual({ file: "launchctl", args: ["bootout", "gui/501/com.teamusage.sync"] });
    expect(f.files.size).toBe(0);
    const g = fake({ run: async () => ({ code: 113, stdout: "", stderr: "not found" }) });
    await expect(removeSchedule("darwin", g.deps)).resolves.toBeUndefined();
  });

  test("linux: adds the tagged line to an empty or missing crontab, writing through stdin", async () => {
    const f = fake();
    await installSchedule("linux", f.deps);
    expect(f.calls).toEqual([
      { file: "crontab", args: ["-l"] },
      { file: "crontab", args: ["-"], input: `${TAGGED}\n` },
    ]);
  });

  test("linux: keeps the other lines, replaces the old one, and install twice changes nothing", async () => {
    const f = fake({ crontab: `0 1 * * * backup\n${OLD}\n` });
    await installSchedule("linux", f.deps);
    expect(f.crontab()).toBe(`0 1 * * * backup\n${TAGGED}\n`);
    await installSchedule("linux", f.deps);
    expect(f.crontab()).toBe(`0 1 * * * backup\n${TAGGED}\n`);
  });

  test("linux: an unreadable crontab stops the install without writing", async () => {
    const f = fake({ run: async () => ({ code: 1, stdout: "", stderr: "permission denied" }) });
    await expect(installSchedule("linux", f.deps)).rejects.toThrow(/nothing was changed/);
  });

  test("linux: remove drops only the tagged line, writes nothing when there is none, and -r when empty", async () => {
    const f = fake({ crontab: `a\n  b\n${TAGGED}\nc` });
    await removeSchedule("linux", f.deps);
    expect(f.crontab()).toBe("a\n  b\nc\n");
    const none = fake({ crontab: "a\n" });
    await removeSchedule("linux", none.deps);
    expect(none.calls.map((c) => c.args[0])).toEqual(["-l"]);
    const only = fake({ crontab: `${TAGGED}\n` });
    await removeSchedule("linux", only.deps);
    expect(only.exists()).toBe(false);
  });

  test("no command line, plist or cron line carries anything but paths, sync and --quiet", async () => {
    const f = fake();
    await installSchedule("darwin", f.deps);
    const g = fake();
    await installSchedule("linux", g.deps);
    const all = JSON.stringify([f.calls, [...f.files.values()], g.calls]);
    expect(all).not.toMatch(/invite|email|@|token/i);
    expect(g.crontab()).toBe(`${TAGGED}\n`);
  });

  test("unsupported platforms are refused", async () => {
    await expect(installSchedule("freebsd", fake().deps)).rejects.toThrow(/not supported/);
  });
});

describe("scheduleStatus", () => {
  const PLIST = "/Users/ann/Library/LaunchAgents/com.teamusage.sync.plist";
  test("not installed, installed and unsupported; read-only", async () => {
    const f = fake();
    expect(await scheduleStatus("darwin", f.deps)).toBe("not installed");
    f.files.set(PLIST, { data: launchdPlist({ nodePath: NODE, cliPath: CLI }), mode: 0o644 });
    expect(await scheduleStatus("darwin", f.deps)).toBe("installed");
    expect(await scheduleStatus("linux", fake({ crontab: `${TAGGED}\n` }).deps)).toBe("installed");
    expect(await scheduleStatus("linux", fake({ crontab: "a\n0 1 * * * x # teamusage\n" }).deps)).toBe("not installed");
    const g = fake();
    await scheduleStatus("linux", g.deps);
    expect(g.calls).toEqual([{ file: "crontab", args: ["-l"] }]);
    expect(await scheduleStatus("win32", f.deps)).toBe("unsupported");
  });

  test("broken when the recorded node or client path no longer exists (plist and cron)", async () => {
    const f = fake({ exists: (p) => p !== CLI });
    f.files.set(PLIST, { data: launchdPlist({ nodePath: NODE, cliPath: CLI }), mode: 0o644 });
    expect(await scheduleStatus("darwin", f.deps)).toBe("broken");
    expect(await scheduleStatus("linux", fake({ crontab: `${TAGGED}\n`, exists: (p) => p !== NODE }).deps)).toBe("broken");
  });

  test("reads back paths with escapes in them", () => {
    const cli = `/Users/a & b/it's <x>/cli.js`;
    expect(parsePlist(launchdPlist({ nodePath: NODE, cliPath: cli }))).toEqual({ nodePath: NODE, cliPath: cli });
    expect(parseCronLine(cronLine({ nodePath: NODE, cliPath: cli }))).toEqual({ nodePath: NODE, cliPath: cli });
  });

  test("an unreadable crontab or plist is unknown, and nothing throws", async () => {
    expect(await scheduleStatus("linux", fake({ run: async () => ({ code: 1, stdout: "", stderr: "denied" }) }).deps)).toBe("unknown");
    expect(await scheduleStatus("linux", fake({ run: async () => { throw new Error("ENOENT"); } }).deps)).toBe("unknown");
    expect(await scheduleStatus("darwin", fake({ readFile: () => { throw new Error("EACCES"); } }).deps)).toBe("unknown");
    const f = fake();
    f.files.set(PLIST, { data: "garbage", mode: 0o644 });
    expect(await scheduleStatus("darwin", f.deps)).toBe("unknown");
  });
});

describe("install refusals and messages", () => {
  test("a custom XDG_CONFIG_HOME is refused with nothing written; the default or an unset one is fine", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const f = fake({ env: { XDG_CONFIG_HOME: "/somewhere/else" } });
      await expect(installSchedule(platform, f.deps)).rejects.toThrow(/custom config location.*without XDG_CONFIG_HOME/);
      expect(f.calls).toEqual([]);
      expect(f.files.size).toBe(0);
    }
    await expect(installSchedule("linux", fake({ env: { XDG_CONFIG_HOME: "/Users/ann/.config/" } }).deps)).resolves.toBeTruthy();
    await expect(installSchedule("linux", fake({ env: { XDG_CONFIG_HOME: "" } }).deps)).resolves.toBeTruthy();
  });

  test("download caches and project-local node_modules are refused; global installs are not", () => {
    const bad = [
      "/Users/a/.npm/_npx/1/node_modules/teamusage/dist/cli.js",
      "/Users/a/Library/Caches/pnpm/dlx/abc/1/node_modules/teamusage/dist/cli.js",
      "/Users/a/.cache/pnpm/dlx-1234/node_modules/teamusage/dist/cli.js",
      "/tmp/xfs-1/dlx-99/node_modules/teamusage/dist/cli.js",
      "/Users/a/.bun/install/cache/teamusage@0.1.0/dist/cli.js",
      "/tmp/bunx-501-teamusage@latest/node_modules/teamusage/dist/cli.js",
      "/Users/a/.yarn/berry/cache/teamusage.zip/node_modules/teamusage/dist/cli.js",
      "/work/project/node_modules/teamusage/dist/cli.js",
      "/work/project/node_modules/.pnpm/teamusage@0.1.0/node_modules/teamusage/dist/cli.js",
    ];
    for (const p of bad) expect(unstableLocation(p), p).toBe(true);
    const good = [
      "/usr/local/lib/node_modules/teamusage/dist/cli.js",
      "/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules/teamusage/dist/cli.js",
      "/Users/a/Library/pnpm/global/5/.pnpm/teamusage@0.1.0/node_modules/teamusage/dist/cli.js",
      "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\teamusage\\dist\\cli.js",
      "/Users/a/code/teamusage/packages/client/dist/cli.js",
    ];
    for (const p of good) expect(unstableLocation(p), p).toBe(false);
  });

  test("install refuses a project-local install, and the success message says to reinstall after a Node upgrade or move", async () => {
    await expect(installSchedule("linux", fake({ cliPath: () => "/work/p/node_modules/teamusage/dist/cli.js" }).deps)).rejects.toThrow(/npm install -g teamusage/);
    for (const platform of ["darwin", "linux"] as const) {
      expect(await installSchedule(platform, fake().deps)).toMatch(/schedule install.* again after upgrading Node or moving the client/);
    }
  });
});

describe("crontab edge cases", () => {
  test("install twice on a CRLF crontab leaves exactly one teamusage line; removal restores the rest", async () => {
    const f = fake({ crontab: "0 1 * * * backup\r\n" });
    await installSchedule("linux", f.deps);
    await installSchedule("linux", f.deps);
    expect(f.crontab()).toBe(`0 1 * * * backup\r\n${TAGGED}\r\n`);
    await removeSchedule("linux", f.deps);
    expect(f.crontab()).toBe("0 1 * * * backup\r\n");
  });

  test("user lines ending in the tag and commented-out teamusage lines survive install and removal", async () => {
    const mine = "0 1 * * * backup # teamusage\n# " + OLD + "\n";
    const f = fake({ crontab: mine });
    await installSchedule("linux", f.deps);
    expect(f.crontab()).toBe(`${mine}${TAGGED}\n`);
    await removeSchedule("linux", f.deps);
    expect(f.crontab()).toBe(mine);
  });

  test("duplicate tagged lines: install leaves exactly one", async () => {
    const f = fake({ crontab: `${OLD}\nx\n${OLD}\n` });
    await installSchedule("linux", f.deps);
    expect(f.crontab().split("\n").filter((l) => l.endsWith("# teamusage"))).toHaveLength(1);
    expect(f.crontab()).toBe(`${TAGGED}\nx\n`);
  });

  test("a crontab -l failure during removal writes nothing", async () => {
    const f = fake({ run: async () => ({ code: 1, stdout: "", stderr: "permission denied" }) });
    await expect(removeSchedule("linux", f.deps)).rejects.toThrow(/nothing was changed/);
    expect(f.crontab()).toBe("");
  });

  test("a path with $ and backticks stays one literal argument through a real shell", () => {
    const l = cronLine({ nodePath: NODE, cliPath: "/Users/a/$(touch pwned)/`id`/$HOME/cli.js" });
    const cmd = l.replace(/^17 \*\/4 \* \* \* /, "").replace(/ # teamusage$/, "").replace(`'${NODE}'`, "printf '[%s]'");
    expect(execFileSync("sh", ["-c", cmd]).toString()).toBe("[/Users/a/$(touch pwned)/`id`/$HOME/cli.js][sync][--quiet]");
  });
});

describe("macOS removal checks the result", () => {
  test("fails, keeping the plist, when the job is still loaded after bootout and unload", async () => {
    const PLIST = "/Users/ann/Library/LaunchAgents/com.teamusage.sync.plist";
    const f = fake({
      run: async (_f, args) => (args[0] === "print" ? ok() : { code: 1, stdout: "", stderr: "x" }),
    });
    f.files.set(PLIST, { data: "x", mode: 0o644 });
    await expect(removeSchedule("darwin", f.deps)).rejects.toThrow(/still loaded/);
    expect(f.files.has(PLIST)).toBe(true);
  });

  test("fails closed when the check itself cannot run", async () => {
    const f = fake({ run: async (_f, args) => { if (args[0] === "print") throw new Error("x"); return ok(); } });
    await expect(removeSchedule("darwin", f.deps)).rejects.toThrow(/could not confirm/);
  });
});

test("the real writeFile is atomic, 0644 whatever the umask, and leaves no temp files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "teamusage-sched-"));
  const old = process.umask(0o077);
  try {
    const run = vi.fn(async () => ok());
    await installSchedule("darwin", { homedir: () => dir, uid: () => 501, run, cliPath: () => CLI, env: {} });
    const agents = path.join(dir, "Library", "LaunchAgents");
    expect(readdirSync(agents)).toEqual(["com.teamusage.sync.plist"]);
    expect(statSync(path.join(agents, "com.teamusage.sync.plist")).mode & 0o777).toBe(0o644);
  } finally {
    process.umask(old);
    rmSync(dir, { recursive: true });
  }
});
