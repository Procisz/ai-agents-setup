import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EXIT,
  KEEP_BACKUPS,
  WfError,
  atomicWrite,
  compareVersions,
  createBackup,
  createGuard,
  listBackups,
  readBackup,
  readManifest,
  preflightTarget,
  removeEmptyDirs,
  resolveNodePath,
  resolvePaths,
  sha256,
  summarizePaths,
  utcStamp,
  writeManifest
} from "../lib/core.mjs";
import { cleanup, makePaths, tmpRoot } from "./data/install/helpers.mjs";

describe("resolvePaths", () => {
  test("defaults to HOME/.claude and HOME/.local/bin", () => {
    const paths = resolvePaths({ env: { HOME: "/home/ana" }, platform: "linux" });
    assert.equal(paths.configHome, "/home/ana/.claude");
    assert.equal(paths.launcherDir, "/home/ana/.local/bin");
    assert.equal(paths.appDir, "/home/ana/.claude/ai-agents-setup");
    assert.equal(paths.pluginDir, "/home/ana/.claude/ai-agents-setup/plugin");
    assert.equal(paths.stateDir, "/home/ana/.claude/ai-agents-setup/state");
    assert.equal(paths.manifestFile, "/home/ana/.claude/ai-agents-setup/manifest.json");
    assert.equal(paths.backupsDir, "/home/ana/.claude/ai-agents-setup/backups");
    assert.equal(paths.adoptedDir, "/home/ana/.claude/ai-agents-setup/adopted");
    assert.equal(paths.rulesDir, "/home/ana/.claude/rules");
    assert.equal(paths.settingsFile, "/home/ana/.claude/settings.json");
    assert.equal(paths.agentsDir, "/home/ana/.claude/agents");
  });

  test("CLAUDE_CONFIG_DIR wins over HOME and the flag wins over both", () => {
    assert.equal(resolvePaths({ env: { HOME: "/home/ana", CLAUDE_CONFIG_DIR: "/cfg" }, platform: "linux" }).configHome, "/cfg");
    assert.equal(resolvePaths({ configDir: "/flag/", env: { HOME: "/home/ana", CLAUDE_CONFIG_DIR: "/cfg" }, platform: "linux" }).configHome, "/flag");
    assert.equal(resolvePaths({ launcherDir: "/bin2", env: { HOME: "/home/ana" }, platform: "linux" }).launcherDir, "/bin2");
  });

  test("a relative config or launcher folder is a usage error", () => {
    assert.throws(() => resolvePaths({ configDir: "rel/dir", env: { HOME: "/h" }, platform: "linux" }), (error) => error instanceof WfError && error.exitCode === EXIT.USAGE);
    assert.throws(() => resolvePaths({ launcherDir: "bin", env: { HOME: "/h" }, platform: "linux" }), (error) => error.exitCode === EXIT.USAGE);
  });

  test("windows paths use USERPROFILE and backslashes", () => {
    const paths = resolvePaths({ env: { USERPROFILE: "C:\\Users\\ana" }, platform: "win32" });
    assert.equal(paths.configHome, "C:\\Users\\ana\\.claude");
    assert.equal(paths.launcherDir, "C:\\Users\\ana\\.local\\bin");
    assert.equal(paths.pluginDir, "C:\\Users\\ana\\.claude\\ai-agents-setup\\plugin");
  });
});

describe("resolveNodePath", () => {
  test("honours appDir/local.json nodePath", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, "local.json"), JSON.stringify({ nodePath: "/opt/node/bin/node" }));
    assert.equal(resolveNodePath({ appDir: root, platform: "linux", execPath: "/usr/bin/node" }), "/opt/node/bin/node");
  });

  test("a relative nodePath in local.json is refused", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, "local.json"), JSON.stringify({ nodePath: "node" }));
    assert.throws(() => resolveNodePath({ appDir: root, platform: "linux" }), WfError);
  });

  test("falls back to the running node", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    assert.equal(resolveNodePath({ appDir: root, platform: "linux", execPath: "/usr/bin/node" }), "/usr/bin/node");
  });

  test("maps a Homebrew Cellar node to the stable opt link when it exists", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const cellar = path.join(root, "Cellar", "node", "24.1.0", "bin", "node");
    const stable = path.join(root, "opt", "node", "bin", "node");
    for (const file of [cellar, stable]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
    }
    assert.equal(resolveNodePath({ appDir: root, platform: "darwin", execPath: cellar }), stable);
  });
});

describe("hashing and writing", () => {
  test("sha256 of a known string", () => {
    assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("atomicWrite writes the content and mode and leaves no temp files", { skip: process.platform === "win32" }, (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const file = path.join(root, "a", "b", "run.sh");
    const hash = atomicWrite(file, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(fs.readFileSync(file, "utf8"), "#!/bin/sh\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.equal(hash, sha256("#!/bin/sh\n"));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["run.sh"]);
  });

  test("atomicWrite refuses to write through a symlink", { skip: process.platform === "win32" }, (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, "real"), "x");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    assert.throws(() => atomicWrite(path.join(root, "link"), "y"), /symlink/);
    assert.equal(fs.readFileSync(path.join(root, "real"), "utf8"), "x");
  });

  test("removeEmptyDirs stops at the first non-empty folder", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, "a", "b", "c"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "keep"), "");
    removeEmptyDirs(path.join(root, "a", "b", "c"), root);
    assert.equal(fs.existsSync(path.join(root, "a", "b")), false);
    assert.equal(fs.existsSync(path.join(root, "a", "keep")), true);
  });
});

describe("write path guard", () => {
  const paths = resolvePaths({ configDir: "/c", launcherDir: "/l", env: { HOME: "/h" }, platform: "linux" });
  const guard = createGuard(paths, "linux");
  const allowed = [
    ["/c/ai-agents-setup/manifest.json", "write"],
    ["/c/ai-agents-setup/plugin/agents/coder-t1.md", "write"],
    ["/c/ai-agents-setup/hooks/gate.mjs", "remove"],
    ["/c/rules/wf-house-rules.md", "write"],
    ["/c/rules/house-rules.md", "write"],
    ["/c/agents/Explore.md", "write"],
    ["/c/agents/wf-coder.md", "remove"],
    ["/c/settings.json", "write"],
    ["/l/wf", "write"],
    ["/l/wf.cmd", "remove"],
    ["/l", "mkdir"],
    ["/c", "mkdir"],
    ["/c/rules", "mkdir"],
    ["/c/ai-agents-setup/plugin/library/seo", "mkdir"],
    ["/c/ai-agents-setup/plugin", "rmtree"],
    ["/c/ai-agents-setup/backups/20261028T120000Z", "rmtree"]
  ];
  const refused = [
    ["/c/settings.local.json", "write"],
    ["/c/.credentials.json", "write"],
    ["/c/rules/other.md", "write"],
    ["/c/agents/coder.md", "write"],
    ["/c/agents/sub/wf-x.md", "write"],
    ["/c/skills/x/SKILL.md", "write"],
    ["/c/ai-agents-setup", "write"],
    ["/c/ai-agents-setup", "rmtree"],
    ["/c/agents", "rmtree"],
    ["/c/skills", "mkdir"],
    ["/l/claude", "write"],
    ["/l/sub/wf", "write"],
    ["/h/.claude.json", "write"],
    ["/c/ai-agents-setup/../settings.local.json", "write"],
    ["relative/wf", "write"],
    ["/c/ai-agents-setup/x", "chmod"]
  ];
  for (const [target, op] of allowed) {
    test(`allows ${op} ${target}`, () => assert.equal(guard.check(target, op), null));
  }
  for (const [target, op] of refused) {
    test(`refuses ${op} ${target}`, () => {
      assert.notEqual(guard.check(target, op), null);
      assert.throws(() => guard.assert(target, op), WfError);
    });
  }

  test("folds case on darwin", () => {
    const mac = createGuard(resolvePaths({ configDir: "/Users/a/.claude", launcherDir: "/Users/a/bin", env: { HOME: "/Users/a" }, platform: "darwin" }), "darwin");
    assert.equal(mac.check("/users/a/.claude/Settings.json", "write"), null);
    assert.equal(mac.check("/Users/a/BIN/WF", "write"), null);
  });
});

describe("backups", () => {
  test("a backup set copies existing files and records missing ones with sha256 null", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    const guard = createGuard(paths);
    atomicWrite(path.join(paths.configHome, "rules", "wf-house-rules.md"), "rules\n");
    atomicWrite(path.join(paths.launcherDir, "wf"), "#!/bin/sh\n", { mode: 0o755 });
    const set = createBackup({
      paths,
      guard,
      command: "install",
      now: new Date("2026-10-28T12:00:00Z"),
      entries: [
        { base: "config", path: "rules/wf-house-rules.md", action: "update" },
        { base: "launcher", path: "wf", action: "update" },
        { base: "config", path: "ai-agents-setup/plugin/agents/x.md", action: "create" },
        { base: "config", path: "rules/wf-house-rules.md", action: "update" }
      ]
    });
    assert.equal(set.stamp, "20261028T120000Z");
    const { index, dir } = readBackup(paths, set.stamp);
    assert.equal(index.schema, "wf.backup/2");
    assert.equal(index.command, "install");
    assert.equal(index.entries.length, 3);
    assert.equal(index.entries[0].sha256, sha256("rules\n"));
    assert.equal(index.entries[2].sha256, null);
    assert.equal(fs.readFileSync(path.join(dir, "files", "config", "rules", "wf-house-rules.md"), "utf8"), "rules\n");
    assert.equal(fs.readFileSync(path.join(dir, "files", "launcher", "wf"), "utf8"), "#!/bin/sh\n");
    if (process.platform !== "win32") assert.equal(index.entries[1].mode, "755");
  });

  test("stamps in the same second get a suffix and only the newest five are kept", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    const guard = createGuard(paths);
    const now = new Date("2026-10-28T12:00:00Z");
    const stamps = [];
    for (let i = 0; i < KEEP_BACKUPS + 2; i += 1) stamps.push(createBackup({ paths, guard, command: "install", entries: [], now }).stamp);
    assert.deepEqual(stamps.slice(0, 3), ["20261028T120000Z", "20261028T120000Z-2", "20261028T120000Z-3"]);
    assert.deepEqual(listBackups(paths), stamps.slice(2));
  });

  test("a protected set is never pruned and does not count toward the five", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    const guard = createGuard(paths);
    const first = createBackup({ paths, guard, command: "install", entries: [], now: new Date("2026-10-28T10:00:00Z") }).stamp;
    for (let i = 1; i <= KEEP_BACKUPS + 1; i += 1) createBackup({ paths, guard, command: "install", entries: [], now: new Date(Date.UTC(2026, 9, 28, 11, i)), protect: [first] });
    const sets = listBackups(paths);
    assert.equal(sets[0], first);
    assert.equal(sets.length, KEEP_BACKUPS + 1);
  });

  test("a backup that dies while copying leaves a listed partial set, so pruning can remove it", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    const guard = createGuard(paths);
    atomicWrite(path.join(paths.configHome, "rules", "wf-house-rules.md"), "rules\n");
    const real = fs.renameSync.bind(fs);
    t.mock.method(fs, "renameSync", (from, to) => {
      if (String(to).includes(`${path.sep}files${path.sep}`)) throw new Error("ENOSPC: no space left on device");
      return real(from, to);
    });
    assert.throws(() => createBackup({ paths, guard, command: "install", now: new Date("2026-10-28T12:00:00Z"), entries: [{ base: "config", path: "rules/wf-house-rules.md", action: "update" }] }), /ENOSPC/);
    t.mock.restoreAll();
    assert.deepEqual(listBackups(paths), ["20261028T120000Z"], "the dead set is listed");
    const { index } = readBackup(paths, "20261028T120000Z");
    assert.equal(index.partial, true);
    assert.deepEqual(index.entries, []);
    for (let i = 1; i <= KEEP_BACKUPS; i += 1) createBackup({ paths, guard, command: "install", entries: [], now: new Date(Date.UTC(2026, 9, 28, 13, i)) });
    assert.equal(listBackups(paths).includes("20261028T120000Z"), false, "and pruned like any other set");
  });

  test("copies are owner-only whatever the source mode", { skip: process.platform === "win32" }, (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    const guard = createGuard(paths);
    atomicWrite(path.join(paths.launcherDir, "wf"), "#!/bin/sh\n", { mode: 0o755 });
    const set = createBackup({ paths, guard, command: "install", now: new Date("2026-10-28T12:00:00Z"), entries: [{ base: "launcher", path: "wf", action: "update" }] });
    assert.equal(fs.statSync(path.join(set.dir, "files", "launcher", "wf")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(set.dir, "index.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(set.dir).mode & 0o777, 0o700);
    assert.equal(readBackup(paths, set.stamp).index.entries[0].mode, "755", "the source mode is recorded for restore");
  });

  test("preflight refuses a symlink, a file in place of a folder and a guarded path before anything is written", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    const guard = createGuard(paths);
    fs.mkdirSync(paths.appDir, { recursive: true });
    fs.writeFileSync(path.join(root, "real.json"), "{}\n");
    if (process.platform !== "win32") {
      fs.symlinkSync(path.join(root, "real.json"), paths.settingsFile);
      assert.match(preflightTarget(paths.settingsFile, "write", guard), /is a symlink; wf never writes through one/);
      assert.equal(preflightTarget(paths.settingsFile, "remove", guard), null, "removing a link only removes the link");
    }
    fs.writeFileSync(path.join(paths.appDir, "plugin"), "x\n");
    assert.match(preflightTarget(path.join(paths.pluginDir, "agents", "a.md"), "write", guard), /plugin is not a folder$/);
    fs.mkdirSync(path.join(paths.configHome, "agents", "Explore.md"), { recursive: true });
    assert.match(preflightTarget(path.join(paths.configHome, "agents", "Explore.md"), "write", guard), /Explore\.md is not a file$/);
    assert.match(preflightTarget(path.join(paths.configHome, "skills", "x", "SKILL.md"), "write", guard), /not a wf path/);
    assert.equal(preflightTarget(path.join(paths.appDir, "new", "deep", "file.json"), "write", guard), null);
    assert.equal(preflightTarget(path.join(paths.appDir, "missing.json"), "remove", guard), null);
  });

  test("listBackups orders by stamp and ignores folders without index.json", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    for (const name of ["20261019T122159Z", "20261013T235721Z", "junk"]) {
      fs.mkdirSync(path.join(paths.backupsDir, name), { recursive: true });
      fs.writeFileSync(path.join(paths.backupsDir, name, "index.json"), '{"entries": []}');
    }
    fs.mkdirSync(path.join(paths.backupsDir, "20261020T000000Z"), { recursive: true });
    assert.deepEqual(listBackups(paths), ["20261013T235721Z", "20261019T122159Z"]);
  });
});

describe("manifest", () => {
  test("round trip and missing manifest", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    assert.deepEqual(readManifest(paths), { exists: false, schema: null, data: null });
    writeManifest(paths, { schema: "wf.manifest/2", files: [] }, createGuard(paths));
    const read = readManifest(paths);
    assert.equal(read.exists, true);
    assert.equal(read.schema, "wf.manifest/2");
  });

  test("invalid JSON is a WfError", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    fs.mkdirSync(paths.appDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, "{nope");
    assert.throws(() => readManifest(paths), WfError);
  });
});

describe("small helpers", () => {
  test("compareVersions", () => {
    assert.equal(compareVersions("2.1.312", "2.1.312"), 0);
    assert.equal(compareVersions("2.1.311", "2.1.312"), -1);
    assert.equal(compareVersions("2.2.0", "2.1.312"), 1);
    assert.equal(compareVersions("x", "2.1.312"), null);
  });

  test("utcStamp", () => {
    assert.equal(utcStamp(new Date("2026-01-02T03:04:05Z")), "20260102T030405Z");
  });

  test("summarizePaths groups long lists by folder", () => {
    assert.deepEqual(summarizePaths(["a/1", "a/2"]), ["a/1", "a/2"]);
    const list = [...Array.from({ length: 9 }, (_, i) => `agents/wf-${i}.md`), "rules/x.md"];
    assert.deepEqual(summarizePaths(list), ["agents/ (9 files)", "rules/x.md"]);
  });

  test("summarizePaths groups by shorter folders until the list fits", () => {
    const list = [];
    for (const skill of ["a", "b", "c", "d", "e", "f", "g"]) list.push(`app/plugin/library/${skill}/SKILL.md`, `app/plugin/library/${skill}/references/x.md`);
    list.push(...Array.from({ length: 15 }, (_, i) => `app/plugin/agents/a${i}.md`), "app/wf-settings.json", "/l/wf");
    assert.deepEqual(summarizePaths(list, 6), ["app/plugin/library/ (14 files)", "app/plugin/agents/ (15 files)", "app/wf-settings.json", "/l/wf"]);
    assert.deepEqual(summarizePaths(list, 3), ["app/plugin/ (29 files)", "app/wf-settings.json", "/l/wf"]);
  });
});
