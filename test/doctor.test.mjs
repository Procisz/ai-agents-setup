import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createBackup, createGuard, readManifest, writeManifest } from "../lib/core.mjs";
import { install } from "../lib/apply.mjs";
import { checkChoices, doctor, hookSelfTest, newRoles } from "../lib/doctor.mjs";
import { checkClaude, findClaude, onPath, parseVersionOutput, pathHint, validatePlugin } from "../lib/claude.mjs";
import { FAKE_CLAUDE, captureIo, cleanup, fakeBuild, fakeSelection, installV1Fixture, makePaths, tmpRoot } from "./data/install/helpers.mjs";

const POSIX = process.platform !== "win32";

async function installed(t, buildOptions = {}) {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const paths = makePaths(root);
  await install({
    paths,
    build: fakeBuild(paths, buildOptions),
    selection: fakeSelection(),
    skills: ["seo"],
    repoRoot: "/repo",
    nodePath: process.execPath,
    env: { PATH: paths.launcherDir },
    yes: true,
    io: captureIo(),
    now: new Date("2026-10-28T12:00:00Z")
  });
  return { root, paths };
}

function envFor(paths, extra = {}) {
  return { PATH: paths.launcherDir, HOME: path.dirname(paths.configHome), ...extra };
}

async function runDoctor(paths, options = {}) {
  const io = captureIo();
  const result = await doctor({ paths, env: envFor(paths, options.env), skipClaude: options.skipClaude ?? true, io, ...(options.minVersion ? { minVersion: options.minVersion } : {}) });
  const by = Object.fromEntries(result.checks.map((item) => [item.name, item]));
  return { ...result, io, by };
}

describe("doctor", () => {
  test("a healthy install passes every check and leaves no ledger behind", async (t) => {
    const { paths } = await installed(t);
    const result = await runDoctor(paths);
    assert.equal(result.code, 0, result.io.text());
    for (const name of ["manifest", "node", "hook node", "launcher", "PATH", "manifest files", "choices", "v1 leftovers", "state folder", "guard hook", "context hook"]) {
      assert.equal(result.by[name]?.status, "ok", `${name}: ${result.by[name]?.detail}`);
    }
    assert.equal(result.by.claude.status, "skip");
    assert.match(result.io.text(), /wf doctor: all good\./);
    const leftovers = fs.existsSync(paths.stateDir) ? fs.readdirSync(paths.stateDir).filter((name) => name.startsWith("wf-doctor-")) : [];
    assert.deepEqual(leftovers, []);
  });

  test("the choices check describes the saved tiers, agents and models and what is missing", () => {
    assert.deepEqual(checkChoices({}), { name: "choices", status: "ok", detail: "everything installed (no saved choices: the next install starts with everything ticked)" });
    const registry = { models: { "claude-sonnet-5-5": { label: "Sonnet 5.5" }, "claude-haiku-5-5": { label: "Haiku 5.5" } } };
    const manifest = {
      choices: { tiers: ["t1", "t2"], roles: ["coder", "docs"], models: ["claude-sonnet-5-5", "claude-haiku-5-5"], known: { tiers: ["t1", "t2", "t3"], roles: ["planner", "docs", "coder", "reviewer"], models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] } },
      agents: [
        { name: "orchestrator", role: "orchestrator", tier: null, model: "claude-sonnet-5-5", remappedFrom: "claude-opus-5-5" },
        { name: "docs-t1", role: "docs", tier: "t1" },
        { name: "coder-t1", role: "coder", tier: "t1" }
      ]
    };
    assert.equal(checkChoices(manifest, registry).detail, "tiers T1, T2; agents docs, coder; models Sonnet 5.5, Haiku 5.5 (T3 not installed, planner not installed, reviewer not installed, 1 agent on a stand-in model)");
    assert.equal(checkChoices(manifest).detail.includes("models claude-sonnet-5-5, claude-haiku-5-5"), true, "without the registry the ids stand in for the labels");
  });

  test("the choices check lists the single git agent with the workers, not as the main agent", () => {
    const registry = {
      models: { "claude-sonnet-5-5": { label: "Sonnet 5.5" } },
      roles: { orchestrator: { main: true }, coder: { tiers: {} }, git: { single: true } }
    };
    const choices = { tiers: ["t1"], roles: ["coder", "git"], models: ["claude-sonnet-5-5"], known: { tiers: ["t1"], roles: ["coder", "git"], models: ["claude-sonnet-5-5"] } };
    const agents = [
      { name: "orchestrator", role: "orchestrator", tier: null },
      { name: "coder-t1", role: "coder", tier: "t1" },
      { name: "git", role: "git", tier: null }
    ];
    assert.equal(checkChoices({ choices, agents }, registry).detail, "tiers T1; agents coder, git; models Sonnet 5.5");
    const without = checkChoices({ choices: { ...choices, roles: ["coder"] }, agents: agents.slice(0, 2) }, registry);
    assert.equal(without.detail, "tiers T1; agents coder; models Sonnet 5.5 (git not installed)");
    const older = checkChoices({ choices: { ...choices, roles: ["coder"], known: { ...choices.known, roles: ["coder"] } }, agents: agents.slice(0, 2) }, registry);
    assert.deepEqual([older.status, older.detail], ["warn", "tiers T1; agents coder; models Sonnet 5.5 (git is new: node wf.mjs install adds it)"]);
  });

  test("the choices check names an unticked debugger and warns about a debugger the last install did not know", () => {
    const workers = ["planner", "docs", "coder", "tester", "reviewer", "debugger"];
    const before = workers.filter((name) => name !== "debugger");
    const registry = {
      models: { "claude-opus-5-5": { label: "Opus 5.5" } },
      roles: Object.fromEntries([["orchestrator", { main: true }], ...workers.map((name) => [name, { tiers: {} }])])
    };
    const all = { tiers: ["t1", "t2", "t3"], models: ["claude-opus-5-5"] };
    const agents = (roles) => [{ name: "orchestrator", role: "orchestrator", tier: null }, ...roles.map((role) => ({ name: `${role}-t1`, role, tier: "t1" }))];
    const unticked = checkChoices({ choices: { ...all, roles: before, known: { ...all, roles: workers } }, agents: agents(before) }, registry);
    assert.equal(unticked.status, "ok");
    assert.equal(unticked.detail, "tiers T1, T2, T3; agents planner, docs, coder, tester, reviewer; models Opus 5.5 (debugger not installed)");
    const older = checkChoices({ choices: { ...all, roles: before, known: { ...all, roles: before } }, agents: agents(before) }, registry);
    assert.equal(older.status, "warn");
    assert.equal(older.detail, "tiers T1, T2, T3; agents planner, docs, coder, tester, reviewer; models Opus 5.5 (debugger is new: node wf.mjs install adds it)");
    const unsaved = checkChoices({ agents: agents(before) }, registry);
    assert.equal(unsaved.status, "warn");
    assert.equal(unsaved.detail, "no saved choices; debugger is new: node wf.mjs install adds it (the next install starts with everything ticked)");
    assert.equal(checkChoices({ agents: agents(workers) }, registry).status, "ok", "an install with every role has nothing new");
    const current = checkChoices({ choices: { ...all, roles: workers, known: { ...all, roles: workers } }, agents: agents(workers) }, registry);
    assert.deepEqual([current.status, current.detail], ["ok", "tiers T1, T2, T3; agents planner, docs, coder, tester, reviewer, debugger; models Opus 5.5"]);
    assert.deepEqual(newRoles({ choices: { known: { roles: ["coder"] } } }, registry), ["planner", "docs", "tester", "reviewer", "debugger"]);
    assert.deepEqual(newRoles({ choices: { known: { roles: before } } }, null), [], "without the registry nothing is new");
    const quoted = "debugger is new: node wf.mjs install adds it";
    for (const detail of [older.detail, unsaved.detail]) assert.ok(detail.includes(quoted), `both doctor forms print the quoted part: ${detail}`);
    for (const doc of ["../docs/guide/wf-guide.html"]) {
      const text = fs.readFileSync(new URL(doc, import.meta.url), "utf8");
      assert.ok(text.includes(quoted), `${doc} quotes the doctor warning`);
      assert.ok(!text.includes(`(${quoted})`), `${doc} quotes only the part that an install without saved choices prints too`);
    }
  });

  test("no manifest is a problem", async (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const result = await runDoctor(makePaths(root));
    assert.equal(result.code, 1);
    assert.equal(result.by.manifest.status, "fail");
    assert.match(result.io.text(), /run node wf\.mjs install/);
  });

  test("a v1 install is reported with its leftovers", async (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = installV1Fixture(root);
    const result = await runDoctor(paths);
    assert.equal(result.code, 1);
    assert.match(result.by.manifest.detail, /v1 install/);
    assert.equal(result.by["v1 leftovers"].status, "fail");
    assert.match(result.by["v1 leftovers"].detail, /settings\.json has 26 v1 hook handlers/);
    assert.match(result.by["v1 leftovers"].detail, /14 v1 agents/);
    assert.match(result.by["v1 leftovers"].detail, /ai-agents-setup\/hooks\//);
  });

  test("a v1 install with missing v1 files names the backup set that restores it", async (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = installV1Fixture(root);
    const set = createBackup({ paths, guard: createGuard(paths), command: "install", entries: [{ base: "config", path: "ai-agents-setup/manifest.json", action: "update" }], now: new Date("2026-10-28T12:00:00Z") });
    fs.unlinkSync(path.join(paths.agentsDir, "wf-coder.md"));
    const result = await runDoctor(paths);
    assert.match(result.by.manifest.detail, new RegExp(`1 of the 23 v1 files are missing, so an earlier install may have stopped half way: node wf\\.mjs restore --to ${set.stamp} puts the v1 install back`));
  });

  test("a complete v1 install gets no restore hint", async (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const result = await runDoctor(installV1Fixture(root));
    assert.doesNotMatch(result.by.manifest.detail, /restore/);
  });

  test("a changed or missing file fails the manifest hashes", async (t) => {
    const { paths } = await installed(t);
    fs.appendFileSync(path.join(paths.pluginDir, "agents", "coder-t1.md"), "x\n");
    fs.unlinkSync(path.join(paths.pluginDir, "library", "seo", "SKILL.md"));
    const result = await runDoctor(paths);
    assert.equal(result.code, 1);
    assert.match(result.by["manifest files"].detail, /2 of \d+ differ/);
    assert.match(result.by["manifest files"].detail, /changed ai-agents-setup\/plugin\/agents\/coder-t1\.md/);
    assert.match(result.by["manifest files"].detail, /missing ai-agents-setup\/plugin\/library\/seo\/SKILL\.md/);
  });

  test("a missing launcher fails and a launcher folder off PATH warns", async (t) => {
    const { paths } = await installed(t);
    fs.unlinkSync(path.join(paths.launcherDir, "wf"));
    const result = await runDoctor(paths, { env: { PATH: "/usr/bin" } });
    assert.equal(result.by.launcher.status, "fail");
    assert.equal(result.by.PATH.status, "warn");
    assert.match(result.by.PATH.detail, /is not on PATH/);
  });

  test("v1 leftovers after a migration: a v1 handler, a wf agent and the Explore override", async (t) => {
    const { paths } = await installed(t);
    const manifest = readManifest(paths).data;
    manifest.migratedFromV1 = { explore: { action: "remove", overrideSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } };
    writeManifest(paths, manifest, createGuard(paths));
    fs.mkdirSync(paths.agentsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.agentsDir, "Explore.md"), "");
    fs.writeFileSync(path.join(paths.agentsDir, "wf-coder.md"), "v1\n");
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/n", args: [path.join(paths.appDir, "hooks", "stop.mjs")] }] }] } }));
    const result = await runDoctor(paths);
    assert.equal(result.by["v1 leftovers"].status, "fail");
    assert.match(result.by["v1 leftovers"].detail, /1 v1 hook handlers/);
    assert.match(result.by["v1 leftovers"].detail, /1 v1 agents in agents\/ \(wf-coder\.md\)/);
    assert.match(result.by["v1 leftovers"].detail, /Explore\.md is still the v1 override/);
  });

  test("a guard that allows a subagent commit fails the self-test", async (t) => {
    const { paths } = await installed(t);
    fs.writeFileSync(path.join(paths.pluginDir, "hooks", "guard.mjs"), "process.exit(0);\n");
    const result = await runDoctor(paths);
    assert.equal(result.by["guard hook"].status, "fail");
    assert.match(result.by["guard hook"].detail, /subagent git commit exit 0 \(want 2\)/);
    assert.equal(result.code, 1);
  });

  test("a guard that refuses wf:git, as before D115, fails the self-test", async (t) => {
    const { paths } = await installed(t);
    const oldGuard = 'let text = "";\nfor await (const chunk of process.stdin) text += chunk;\nif (JSON.parse(text).tool_input.command.includes("commit")) {\n  process.stderr.write("wf guard: refused\\n");\n  process.exitCode = 2;\n}\n';
    fs.writeFileSync(path.join(paths.pluginDir, "hooks", "guard.mjs"), oldGuard);
    const guard = hookSelfTest({ paths, env: envFor(paths) }).find((item) => item.name === "guard hook");
    assert.equal(guard.status, "fail");
    assert.match(guard.detail, /subagent git commit exit 2 \(want 2\), git status exit 0 \(want 0\), wf:git git commit exit 2 \(want 0\)/);
  });

  test("the guard self-test passes with the repo guard and names the three cases", async (t) => {
    const { paths } = await installed(t);
    const guard = hookSelfTest({ paths, env: envFor(paths) }).find((item) => item.name === "guard hook");
    assert.deepEqual([guard.status, guard.detail], ["ok", "refuses a subagent git commit, allows git status and a wf:git commit"]);
  });

  test("a context hook that writes no ledger fails the self-test", async (t) => {
    const { paths } = await installed(t);
    fs.writeFileSync(path.join(paths.pluginDir, "hooks", "context.mjs"), "process.exit(0);\n");
    const checks = hookSelfTest({ paths, env: envFor(paths) });
    const context = checks.find((item) => item.name === "context hook");
    assert.equal(context.status, "fail");
    assert.match(context.detail, /ledger tokens none \(want 10200\)/);
  });

  test("missing hook scripts fail the self-test", async (t) => {
    const { paths } = await installed(t, { omit: ["ai-agents-setup/plugin/hooks/guard.mjs"] });
    const checks = hookSelfTest({ paths, env: envFor(paths) });
    assert.equal(checks[0].status, "fail");
    assert.match(checks[0].detail, /missing .*guard\.mjs/);
  });

  test("a missing compact module fails the self-test (D123)", async (t) => {
    const { paths } = await installed(t, { omit: ["ai-agents-setup/plugin/hooks/compact.mjs"] });
    const checks = hookSelfTest({ paths, env: envFor(paths) });
    assert.equal(checks[0].status, "fail");
    assert.match(checks[0].detail, /missing .*compact\.mjs/);
  });

  test("a hook node that does not run is a problem", async (t) => {
    const { paths } = await installed(t);
    const manifest = readManifest(paths).data;
    manifest.nodePath = path.join(paths.configHome, "no-such-node");
    writeManifest(paths, manifest, createGuard(paths));
    const result = await runDoctor(paths);
    assert.equal(result.by["hook node"].status, "fail");
    assert.equal(result.by["hook self-test"]?.status, "skip", "the self-test does not pass on another node");
    assert.equal(result.by["guard hook"], undefined);
  });

  test("an unwritable state folder is a problem", { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
    const { paths } = await installed(t);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.chmodSync(paths.stateDir, 0o500);
    let result;
    try {
      result = await runDoctor(paths);
    } finally {
      fs.chmodSync(paths.stateDir, 0o755);
    }
    assert.equal(result.by["state folder"].status, "fail");
  });

  test("with Claude Code: version and plugin validate", async (t) => {
    const { paths } = await installed(t);
    const result = await runDoctor(paths, { skipClaude: false, env: { WF_CLAUDE_BIN: FAKE_CLAUDE } });
    assert.equal(result.by.claude.status, "ok");
    assert.match(result.by.claude.detail, /2\.1\.312/);
    assert.equal(result.by["plugin validate"].status, "ok");
    assert.equal(result.code, 0);
  });

  test("a failing plugin validate and an old Claude Code are problems", async (t) => {
    const { paths } = await installed(t);
    const failing = await runDoctor(paths, { skipClaude: false, env: { WF_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_VALIDATE: "fail" } });
    assert.equal(failing.by["plugin validate"].status, "fail");
    assert.match(failing.by["plugin validate"].detail, /name is missing/);
    const old = await runDoctor(paths, { skipClaude: false, env: { WF_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_VERSION: "2.1.300" } });
    assert.equal(old.by.claude.status, "fail");
    assert.match(old.by.claude.detail, /claude update/);
  });

  test("plugin validate is skipped when the command does not exist", async (t) => {
    const { paths } = await installed(t);
    const result = await runDoctor(paths, { skipClaude: false, env: { WF_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_NO_VALIDATE: "1" } });
    assert.equal(result.by["plugin validate"].status, "skip");
    assert.equal(result.code, 0);
  });
});

describe("claude helpers", () => {
  test("parseVersionOutput", () => {
    assert.equal(parseVersionOutput("2.1.312 (Claude Code)\n"), "2.1.312");
    assert.equal(parseVersionOutput("2.1.312\n"), "2.1.312");
    assert.equal(parseVersionOutput("nope"), null);
  });

  test("checkClaude: not found, ok, too old", () => {
    assert.equal(checkClaude({ env: { PATH: "" }, platform: "linux" }).found, false);
    const ok = checkClaude({ env: { WF_CLAUDE_BIN: FAKE_CLAUDE } });
    assert.equal(ok.ok, true);
    assert.equal(ok.version, "2.1.312");
    const old = checkClaude({ env: { WF_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_VERSION: "2.1.311" } });
    assert.equal(old.ok, false);
    assert.match(old.message, /older than 2\.1\.312\. Run: claude update/);
  });

  test("checkClaude finds claude on PATH", { skip: !POSIX }, (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const bin = path.join(root, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\necho '2.1.400 (Claude Code)'\n", { mode: 0o755 });
    const result = checkClaude({ env: { PATH: `/nonexistent:${root}` }, platform: process.platform });
    assert.equal(result.ok, true);
    assert.equal(result.version, "2.1.400");
    assert.equal(result.bin.path, bin);
  });

  test("validatePlugin passes the plugin folder", () => {
    const bin = { command: process.execPath, args: [FAKE_CLAUDE], path: FAKE_CLAUDE };
    assert.deepEqual(validatePlugin(bin, "/x/plugin", { env: {} }), { ran: true, ok: true, detail: "claude plugin validate passed" });
  });

  test("on win32 an npm claude.cmd is skipped for a claude.exe later on PATH", () => {
    const files = new Set(["C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Users\\u\\.local\\bin\\claude.exe"]);
    const isExecutable = (file) => files.has(file);
    const env = { Path: "C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Users\\u\\.local\\bin", PATHEXT: ".EXE;.CMD;.BAT" };
    assert.equal(findClaude({ env: { ...env, PATHEXT: ".CMD;.EXE" }, platform: "win32", isExecutable }).path, "C:\\Users\\u\\.local\\bin\\claude.exe");
    assert.equal(findClaude({ env, platform: "win32", isExecutable }).path, "C:\\Users\\u\\.local\\bin\\claude.exe");
  });

  test("on win32 a claude.cmd alone gets a clear message instead of a version failure", () => {
    const files = new Set(["C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd"]);
    const result = checkClaude({ env: { Path: "C:\\Users\\u\\AppData\\Roaming\\npm", PATHEXT: ".EXE;.CMD" }, platform: "win32", isExecutable: (file) => files.has(file) });
    assert.equal(result.ok, false);
    assert.equal(result.found, true);
    assert.equal(result.bin, null);
    assert.match(result.message, /found only C:\\Users\\u\\AppData\\Roaming\\npm\\claude\.cmd, an npm shim that Node cannot start without a shell/);
    assert.match(result.message, /WF_CLAUDE_BIN/);
  });

  test("a version that cannot be read names the cause", { skip: !POSIX }, (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const bin = path.join(root, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const result = checkClaude({ env: { PATH: root }, platform: process.platform });
    assert.match(result.message, /could not read the Claude Code version from .+ --version \(exit 3\)/);
  });

  test("pathHint names ~/.bash_profile for bash on macOS and ~/.bashrc elsewhere", () => {
    assert.match(pathHint("/Users/ann/.local/bin", { env: { SHELL: "/bin/bash" }, platform: "darwin" }), />> ~\/\.bash_profile,/);
    assert.match(pathHint("/home/ann/.local/bin", { env: { SHELL: "/bin/bash" }, platform: "linux" }), />> ~\/\.bashrc,/);
    assert.match(pathHint("/Users/ann/.local/bin", { env: { SHELL: "/bin/zsh" }, platform: "darwin" }), />> ~\/\.zshrc,/);
  });

  test("pathHint quotes a folder with an apostrophe so the sh command writes the right line", { skip: !POSIX }, () => {
    const dir = "/home/o'neil/my $dir/.local/bin";
    const hint = pathHint(dir, { env: { SHELL: "/bin/bash" }, platform: "linux" });
    const command = /Add it: (echo .*) >> ~\/\.bashrc, then open a new terminal\.$/.exec(hint)[1];
    const echoed = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.equal(echoed.status, 0, echoed.stderr);
    assert.equal(echoed.stdout, `export PATH="/home/o'neil/my \\$dir/.local/bin:$PATH"\n`);
    const sourced = spawnSync("/bin/sh", ["-c", `${echoed.stdout.trim()}; printf %s "$PATH"`], { encoding: "utf8", env: { PATH: "/usr/bin" } });
    assert.equal(sourced.stdout, `${dir}:/usr/bin`);
  });

  test("pathHint doubles every apostrophe of a Windows folder inside the PowerShell string", () => {
    const hint = pathHint("C:\\Users\\Ann O'Neil\\.local\\bin", { env: {}, platform: "win32" });
    assert.ok(hint.includes("+ ';C:\\Users\\Ann O''Neil\\.local\\bin', 'User')"), hint);
    const curly = pathHint("C:\\Users\\Ann O\u2019Neil\\bin", { env: {}, platform: "win32" });
    assert.ok(curly.includes("O\u2019\u2019Neil"), curly);
  });

  test("onPath compares normalised entries and pathHint names the shell rc file", () => {
    assert.equal(onPath("/home/a/.local/bin", { env: { PATH: "/usr/bin:/home/a/.local/bin/" }, platform: "linux" }), true);
    assert.equal(onPath("/home/a/.local/bin", { env: { PATH: "/usr/bin" }, platform: "linux" }), false);
    assert.equal(onPath("C:\\Users\\a\\.local\\bin", { env: { Path: "C:\\Windows;c:\\users\\a\\.local\\bin" }, platform: "win32" }), true);
    assert.match(pathHint("/home/a/.local/bin", { env: { SHELL: "/bin/zsh" }, platform: "linux" }), /~\/\.zshrc/);
    assert.match(pathHint("/home/a/.local/bin", { env: { SHELL: "/bin/bash" }, platform: "linux" }), /~\/\.bashrc/);
    assert.match(pathHint("C:\\bin", { env: {}, platform: "win32" }), /SetEnvironmentVariable/);
  });
});
