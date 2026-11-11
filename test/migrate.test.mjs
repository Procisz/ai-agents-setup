import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listBackups, readBackup, readManifest, sha256 } from "../lib/core.mjs";
import { install, restore, uninstall } from "../lib/apply.mjs";
import { detectStyle, migrateSettings, planMigration, pointsIntoV1Hooks, renderJson } from "../lib/migrate.mjs";
import { captureIo, cleanup, fakeBuild, fakeSelection, installV1Fixture, snapshot, tmpRoot } from "./data/install/helpers.mjs";

const NOW = new Date("2026-10-28T12:00:00Z");
const LATER = new Date("2026-10-28T12:30:00Z");
const V1_AGENTS = ["coder-hard", "coder", "debugger", "docs", "git", "orchestrator", "plan-writer", "planner", "scout", "spec-writer", "test-writer-deep", "test-writer", "verifier-deep", "verifier"];
const V1_HOOKS = ["common.mjs", "gate.mjs", "ledger.mjs", "policy.json", "shell.mjs", "stop.mjs"];

function setup(t) {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const paths = installV1Fixture(root);
  const originals = snapshot(root);
  return { root, paths, originals };
}

async function run(paths, extra = {}) {
  const io = extra.io ?? captureIo();
  const result = await install({
    paths,
    build: fakeBuild(paths),
    selection: fakeSelection(),
    skills: ["seo"],
    repoRoot: "/repo",
    nodePath: process.execPath,
    env: { PATH: paths.launcherDir },
    yes: true,
    io,
    now: NOW,
    ...extra,
    io
  });
  return { ...result, io };
}

function readSettings(paths) {
  return JSON.parse(fs.readFileSync(paths.settingsFile, "utf8"));
}

function allHandlers(settings) {
  return Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks));
}

describe("the fixture is shaped like the real v1 install", () => {
  test("manifest wf.manifest/1 with 23 files, 2 adopted, homeTrust and settings ownership", (t) => {
    const { paths } = setup(t);
    const manifest = readManifest(paths).data;
    assert.equal(manifest.schema, "wf.manifest/1");
    assert.equal(manifest.files.length, 23);
    assert.equal(manifest.adopted.length, 2);
    assert.equal(manifest.settings.hooks.length, 26);
    assert.equal(manifest.settings.deny.length, 2);
    assert.ok(manifest.settings.containers.includes("/permissions/deny"));
    assert.equal(path.normalize(manifest.homeTrust.file), path.join(paths.configHome, "..", "home", ".claude.json"));
    for (const entry of manifest.files) {
      const file = path.join(entry.base === "launcher" ? paths.launcherDir : paths.configHome, entry.path);
      assert.equal(sha256(fs.readFileSync(file)), entry.sha256, `sha256 of ${entry.path}`);
    }
  });

  test("settings.json is tab indented with 26 v1 handlers and the user's PermissionRequest hook", (t) => {
    const { paths } = setup(t);
    const text = fs.readFileSync(paths.settingsFile, "utf8");
    assert.ok(text.startsWith('{\n\t"env"'));
    const settings = JSON.parse(text);
    assert.equal(allHandlers(settings).filter((handler) => pointsIntoV1Hooks(handler, paths.appDir)).length, 26);
    assert.equal(settings.hooks.PermissionRequest.length, 1);
    assert.equal(detectStyle(text, settings).lossless, true);
  });
});

describe("v1 migration through install", () => {
  test("backs up everything first: every v1 file, settings.json, Explore.md and the manifest", async (t) => {
    const { paths, originals } = setup(t);
    await run(paths);
    const sets = listBackups(paths);
    assert.equal(sets.length, 1);
    const { index, dir } = readBackup(paths, sets[0]);
    const byPath = new Map(index.entries.map((entry) => [`${entry.base}:${entry.path}`, entry]));
    const expected = [
      ...V1_AGENTS.map((name) => `config:agents/wf-${name}.md`),
      ...V1_HOOKS.map((name) => `config:ai-agents-setup/hooks/${name}`),
      "config:agents/Explore.md",
      "config:rules/wf-house-rules.md",
      "config:settings.json",
      "config:ai-agents-setup/manifest.json",
      "launcher:wf"
    ];
    for (const key of expected) {
      const entry = byPath.get(key);
      assert.ok(entry, `${key} is in the backup`);
      const [base, rel] = key.split(/:(.*)/s);
      const copy = fs.readFileSync(path.join(dir, "files", base, ...rel.split("/")), "utf8");
      assert.equal(copy, originals[`${base}/${rel}`], `${key} copy equals the original`);
    }
  });

  test("removes every v1 file and replaces the launcher and the house rules", async (t) => {
    const { paths } = setup(t);
    const result = await run(paths);
    assert.equal(result.code, 0);
    for (const name of V1_AGENTS) assert.equal(fs.existsSync(path.join(paths.agentsDir, `wf-${name}.md`)), false, `wf-${name}.md removed`);
    assert.equal(fs.existsSync(path.join(paths.appDir, "hooks")), false, "the v1 hooks folder is gone");
    assert.match(fs.readFileSync(path.join(paths.launcherDir, "wf"), "utf8"), /--plugin-dir/);
    assert.match(fs.readFileSync(path.join(paths.rulesDir, "wf-house-rules.md"), "utf8"), /v2 house rules/);
  });

  test("restores the Explore original whose sha256 matches the adopted record", async (t) => {
    const { paths, originals } = setup(t);
    await run(paths);
    const manifest = readManifest(paths).data;
    const live = fs.readFileSync(path.join(paths.agentsDir, "Explore.md"), "utf8");
    assert.equal(live, originals["config/ai-agents-setup/adopted/agents/Explore.md"]);
    assert.equal(sha256(live), JSON.parse(originals["config/ai-agents-setup/manifest.json"]).adopted[0].sha256);
    assert.deepEqual(manifest.migratedFromV1.restored, ["agents/Explore.md"]);
    assert.equal(manifest.migratedFromV1.explore.action, "restore");
  });

  test("settings.json: v1 entries removed one by one, everything else kept, tabs and trailing newline kept", async (t) => {
    const { paths, originals } = setup(t);
    await run(paths);
    const text = fs.readFileSync(paths.settingsFile, "utf8");
    assert.ok(text.startsWith('{\n\t"env": {\n\t\t"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"'), "tab indentation kept");
    assert.ok(text.endsWith("}\n"), "trailing newline kept");
    const before = JSON.parse(originals["config/settings.json"]);
    const after = JSON.parse(text);
    assert.equal(allHandlers(after).some((handler) => pointsIntoV1Hooks(handler, paths.appDir)), false, "no handler points into ai-agents-setup/hooks/");
    assert.equal(after.hooks.PreToolUse, undefined, "PreToolUse emptied and removed");
    assert.equal(after.hooks.SubagentStop, undefined, "SubagentStop emptied and removed");
    assert.equal(after.hooks.SubagentStart, undefined, "SubagentStart emptied and removed");
    assert.equal(after.hooks.PostToolUse, undefined, "PostToolUse emptied and removed");
    assert.equal(after.permissions.deny, undefined, "deny emptied and pruned because v1 created it");
    assert.equal(Object.hasOwn(after.env, "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"), false, "spawn depth removed: absent before v1");
    assert.deepEqual(after.hooks.PermissionRequest, before.hooks.PermissionRequest, "the user's PermissionRequest hook kept");
    assert.equal(after.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, "1", "the user's env kept");
    assert.equal(after.permissions.defaultMode, "bypassPermissions", "defaultMode kept");
    assert.equal(after.skipDangerousModePermissionPrompt, true, "skipDangerousModePermissionPrompt kept");
    assert.equal(after.model, "claude-opus-5-5", "model kept");
    assert.deepEqual(after.modelSettings, before.modelSettings, "modelSettings kept");
    assert.equal(after.ultracode, true, "ultracode kept");
    assert.equal(after.disableClaudeAiConnectors, true, "disableClaudeAiConnectors kept");
    assert.equal(after.enableWorkflows, true, "enableWorkflows kept");
    const expected = structuredClone(before);
    delete expected.hooks.PreToolUse;
    delete expected.hooks.SubagentStop;
    delete expected.hooks.SubagentStart;
    delete expected.hooks.PostToolUse;
    delete expected.permissions.deny;
    delete expected.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    assert.deepEqual(after, expected, "nothing else changed");
    assert.deepEqual(Object.keys(after), Object.keys(before), "top-level key order kept");
    assert.equal(text, renderJson(expected, "\t", true) + "\n", "same formatting as the original, inline arrays included");
  });

  test("leaves homeTrust, cost/ and adopted/ alone and records the migration", async (t) => {
    const { paths, originals, root } = setup(t);
    const result = await run(paths);
    const after = snapshot(root);
    assert.equal(after["home/.claude.json"], originals["home/.claude.json"]);
    assert.equal(after["config/ai-agents-setup/cost/sessions.jsonl"], originals["config/ai-agents-setup/cost/sessions.jsonl"]);
    assert.equal(after["config/ai-agents-setup/adopted/agents/Explore.md"], originals["config/ai-agents-setup/adopted/agents/Explore.md"]);
    assert.equal(after["config/ai-agents-setup/adopted/rules/house-rules.md"], originals["config/ai-agents-setup/adopted/rules/house-rules.md"]);
    const manifest = readManifest(paths).data;
    assert.equal(manifest.schema, "wf.manifest/2");
    const record = manifest.migratedFromV1;
    assert.equal(record.backup, listBackups(paths)[0]);
    assert.equal(record.removed.length, 20);
    assert.equal(record.replaced.length, 2);
    assert.equal(record.settings.removed.filter((item) => item.startsWith("hooks.")).length, 26);
    assert.ok(record.settings.removed.includes("permissions.deny Agent(model:*)"));
    assert.ok(record.settings.removed.includes("permissions.deny Agent(effort:*)"));
    assert.ok(record.settings.removed.includes("env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"));
    for (const key of ["hooks.PermissionRequest", "permissions.defaultMode", "model", "modelSettings", "ultracode", "disableClaudeAiConnectors", "enableWorkflows", "skipDangerousModePermissionPrompt", "env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"]) {
      assert.ok(record.settings.kept.includes(key), `${key} reported as kept`);
    }
    assert.equal(path.normalize(record.left.homeTrust.file), path.join(root, "home", ".claude.json"));
    assert.equal(record.left.cost, "ai-agents-setup/cost/");
    assert.deepEqual(manifest.adopted.map((entry) => entry.path), ["rules/house-rules.md"]);
    assert.match(result.io.text(), /v1 migration/);
    assert.match(result.io.text(), /remove 26 wf hook handlers/);
  });

  test("is idempotent: a second install reports 0 changes and touches nothing", async (t) => {
    const { paths, root } = setup(t);
    await run(paths);
    const before = snapshot(root);
    const second = await run(paths, { now: LATER });
    assert.equal(second.changes, 0);
    assert.match(second.io.text(), /0 changes/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(listBackups(paths).length, 1);
  });

  test("the migration backup is never pruned by later installs", async (t) => {
    const { paths } = setup(t);
    await run(paths);
    const migrationSet = readManifest(paths).data.migratedFromV1.backup;
    for (let i = 1; i <= 7; i += 1) {
      await run(paths, { build: fakeBuild(paths, { agentBody: `round ${i}` }), now: new Date(Date.UTC(2026, 9, 28, 13, i)) });
    }
    const sets = listBackups(paths);
    assert.ok(sets.includes(migrationSet), "the migration set is still there");
    assert.equal(sets.length, 6);
  });

  test("restore of the migration backup brings the v1 install back", async (t) => {
    const { paths, root, originals } = setup(t);
    await run(paths);
    const result = await restore({ paths, yes: true, io: captureIo(), now: LATER });
    assert.equal(result.code, 0);
    const after = snapshot(root);
    for (const [rel, text] of Object.entries(originals)) assert.equal(after[rel], text, `${rel} is back`);
    assert.equal(fs.existsSync(paths.pluginDir), false, "the v2 plugin files are removed");
    assert.equal(readManifest(paths).schema, "wf.manifest/1");
  });

  test("dry run prints the migration and writes nothing", async (t) => {
    const { paths, root, originals } = setup(t);
    const result = await run(paths, { dryRun: true });
    assert.match(result.io.text(), /v1 migration/);
    assert.match(result.io.text(), /agents\/Explore\.md: restore your original/);
    assert.deepEqual(snapshot(root), originals);
  });

  test("a modified v1 file is backed up with its modification and removed", async (t) => {
    const { paths } = setup(t);
    fs.appendFileSync(path.join(paths.agentsDir, "wf-coder.md"), "local edit\n");
    const result = await run(paths);
    assert.match(result.io.text(), /remove 20 v1 files/);
    assert.equal(fs.existsSync(path.join(paths.agentsDir, "wf-coder.md")), false);
    const { dir } = readBackup(paths, listBackups(paths)[0]);
    assert.match(fs.readFileSync(path.join(dir, "files", "config", "agents", "wf-coder.md"), "utf8"), /local edit/);
  });

  test("an adopted Explore original that fails its sha256 is not restored: the override is removed and reported", async (t) => {
    const { paths } = setup(t);
    fs.appendFileSync(path.join(paths.adoptedDir, "agents", "Explore.md"), "tampered\n");
    const result = await run(paths);
    assert.equal(fs.existsSync(path.join(paths.agentsDir, "Explore.md")), false);
    assert.match(result.io.text(), /does not match its sha256: the v1 override is removed/);
    assert.equal(readManifest(paths).data.migratedFromV1.explore.action, "remove");
  });

  test("an Explore override with no adopted record is removed", async (t) => {
    const { paths } = setup(t);
    const manifest = JSON.parse(fs.readFileSync(paths.manifestFile, "utf8"));
    manifest.adopted = manifest.adopted.filter((entry) => entry.path !== "agents/Explore.md");
    fs.writeFileSync(paths.manifestFile, JSON.stringify(manifest));
    const result = await run(paths);
    assert.equal(fs.existsSync(path.join(paths.agentsDir, "Explore.md")), false);
    assert.match(result.io.text(), /no adopted original/);
  });

  test("invalid settings.json stops the install before anything is written", async (t) => {
    const { paths, root, originals } = setup(t);
    fs.writeFileSync(paths.settingsFile, "{ broken");
    await assert.rejects(run(paths), /settings\.json is not valid JSON/);
    const after = snapshot(root);
    assert.equal(after["config/settings.json"], "{ broken");
    delete after["config/settings.json"];
    const expected = { ...originals };
    delete expected["config/settings.json"];
    assert.deepEqual(after, expected);
  });

  test("works without a settings.json", async (t) => {
    const { paths } = setup(t);
    fs.unlinkSync(paths.settingsFile);
    const result = await run(paths);
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(paths.settingsFile), false);
    assert.equal(readManifest(paths).data.migratedFromV1.settings, null);
  });

  test("plan only: the migration lists 20 removals and the replaced files", (t) => {
    const { paths } = setup(t);
    const v1 = readManifest(paths).data;
    const plan = planMigration({ paths, v1, writeTargets: new Set(["config:rules/wf-house-rules.md", "launcher:wf"]) });
    assert.equal(plan.removeFiles.length, 20);
    assert.deepEqual(plan.replaced.map((item) => item.path).sort(), ["rules/wf-house-rules.md", "wf"]);
    assert.equal(plan.explore.action, "restore");
    assert.equal(plan.changeCount, 22);
  });
});

function withoutBackups(tree) {
  return Object.fromEntries(Object.entries(tree).filter(([rel]) => !rel.startsWith("config/ai-agents-setup/backups/")));
}

function failRenames(t, shouldFail) {
  const real = fs.renameSync.bind(fs);
  const realUnlink = fs.unlinkSync.bind(fs);
  const state = { crashed: false };
  const denied = (what) => {
    const error = new Error(`EACCES: permission denied, ${what}`);
    error.code = "EACCES";
    return error;
  };
  t.mock.method(fs, "renameSync", (from, to) => {
    if (state.crashed || shouldFail(String(to), state)) throw denied(`rename '${from}' -> '${to}'`);
    return real(from, to);
  });
  t.mock.method(fs, "unlinkSync", (file) => {
    if (state.crashed && !String(file).endsWith(".tmp")) throw denied(`unlink '${file}'`);
    return realUnlink(file);
  });
  return state;
}

describe("a failure while the v1 migration is applied", () => {
  test("a symlinked settings.json is refused before the backup and every v1 file stays in place", { skip: process.platform === "win32" }, async (t) => {
    const { root, paths } = setup(t);
    const real = path.join(root, "dotfiles", "settings.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.renameSync(paths.settingsFile, real);
    fs.symlinkSync(real, paths.settingsFile);
    const before = snapshot(root);
    await assert.rejects(run(paths), /cannot install: .*settings\.json is a symlink.*Nothing was written\./);
    assert.deepEqual(snapshot(root), before, "nothing changed");
    assert.equal(listBackups(paths).length, 0, "no backup set either");
    assert.equal(fs.lstatSync(paths.settingsFile).isSymbolicLink(), true);
  });

  test("a plugin path blocked by a file is refused before anything is written", async (t) => {
    const { root, paths } = setup(t);
    fs.writeFileSync(path.join(paths.appDir, "plugin"), "not a folder\n");
    const before = snapshot(root);
    await assert.rejects(run(paths), /cannot install: .*plugin is not a folder/);
    assert.deepEqual(snapshot(root), before);
  });

  test("a write that fails after the migration step is rolled back from the backup", async (t) => {
    const { root, paths, originals } = setup(t);
    const launcher = path.join(paths.launcherDir, "wf");
    failRenames(t, (to) => to === launcher);
    await assert.rejects(run(paths), /install failed after the backup: EACCES.*Everything was put back from backup \d{8}T\d{6}Z, so nothing changed/);
    assert.deepEqual(withoutBackups(snapshot(root)), originals, "every v1 file, settings.json and the manifest are back");
    assert.equal(readManifest(paths).schema, "wf.manifest/1");
  });

  test("when the rollback fails too the error names the restore stamp, and that restore brings v1 back", async (t) => {
    const { root, paths, originals } = setup(t);
    const launcher = path.join(paths.launcherDir, "wf");
    const state = failRenames(t, (to) => {
      if (to === launcher) {
        state.crashed = true;
        return true;
      }
      return false;
    });
    const error = await run(paths).then(
      () => null,
      (caught) => caught
    );
    assert.ok(error, "the install fails");
    const stamp = /restore --to (\d{8}T\d{6}Z)/.exec(error.message)?.[1];
    assert.ok(stamp, `the message names the stamp: ${error.message}`);
    state.crashed = false;
    t.mock.restoreAll();
    const result = await restore({ paths, to: stamp, yes: true, io: captureIo(), now: LATER });
    assert.equal(result.code, 0);
    assert.deepEqual(withoutBackups(snapshot(root)), originals);
  });

  test("after a crash a rerun records the first backup set, keeps it and lists what the first attempt removed", async (t) => {
    const { paths } = setup(t);
    const launcher = path.join(paths.launcherDir, "wf");
    const state = failRenames(t, (to) => {
      if (to === launcher) {
        state.crashed = true;
        return true;
      }
      return false;
    });
    await assert.rejects(run(paths));
    const [first] = listBackups(paths);
    assert.equal(readManifest(paths).schema, "wf.manifest/1", "the crash left the v1 manifest");
    assert.equal(fs.existsSync(path.join(paths.agentsDir, "wf-coder.md")), false, "the crash removed the v1 agents");
    t.mock.restoreAll();
    const rerun = await run(paths, { now: new Date("2026-10-28T12:01:00Z") });
    assert.equal(rerun.code, 0);
    const record = readManifest(paths).data.migratedFromV1;
    assert.equal(record.backup, first, "the set that holds the v1 originals is recorded");
    assert.equal(record.removed.length, 20, "the removals of the first attempt are listed");
    assert.equal(record.settings.removed.filter((item) => item.startsWith("hooks.")).length, 26, "the settings removals of the first attempt are listed");
    for (let i = 1; i <= 6; i += 1) {
      await run(paths, { build: fakeBuild(paths, { agentBody: `round ${i}` }), now: new Date(Date.UTC(2026, 9, 28, 13, i)) });
    }
    assert.ok(listBackups(paths).includes(first), "the first set survives later installs");
    const { index } = readBackup(paths, first);
    assert.ok(index.entries.some((entry) => entry.path === "agents/wf-coder.md" && entry.sha256), "the kept set holds the v1 agents");
  });

  test("repeated failed reruns never prune the set that holds the v1 originals", async (t) => {
    const { paths } = setup(t);
    const launcher = path.join(paths.launcherDir, "wf");
    const state = failRenames(t, (to) => {
      if (to === launcher) {
        state.crashed = true;
        return true;
      }
      return false;
    });
    await assert.rejects(run(paths));
    const [first] = listBackups(paths);
    for (let i = 1; i <= 7; i += 1) {
      state.crashed = false;
      await assert.rejects(run(paths, { now: new Date(Date.UTC(2026, 9, 28, 12, i)) }));
    }
    assert.ok(listBackups(paths).includes(first), "the first set is still there");
    const { index } = readBackup(paths, first);
    assert.equal(index.entries.filter((entry) => /^agents\/wf-.+\.md$/.test(entry.path) && entry.sha256).length, 14, "it holds the 14 v1 agents");
  });

  test("a crash right before the manifest write finishes on the 0 change path with the first set recorded", async (t) => {
    const { paths } = setup(t);
    const state = failRenames(t, (to) => {
      if (to === paths.manifestFile) {
        state.crashed = true;
        return true;
      }
      return false;
    });
    await assert.rejects(run(paths));
    const [first] = listBackups(paths);
    t.mock.restoreAll();
    const rerun = await run(paths, { now: LATER });
    assert.equal(rerun.changes, 0);
    assert.match(rerun.io.text(), /0 changes/);
    assert.deepEqual(listBackups(paths), [first], "no new set: the first one holds the v1 manifest");
    const data = readManifest(paths).data;
    assert.equal(data.schema, "wf.manifest/2");
    assert.equal(data.migratedFromV1.backup, first);
    assert.equal(data.migratedFromV1.removed.length, 20);
  });

  test("the 0 change path backs up the v1 manifest when no earlier set holds it", async (t) => {
    const { paths } = setup(t);
    const state = failRenames(t, (to) => {
      if (to === paths.manifestFile) {
        state.crashed = true;
        return true;
      }
      return false;
    });
    await assert.rejects(run(paths));
    t.mock.restoreAll();
    const v1Text = fs.readFileSync(paths.manifestFile, "utf8");
    fs.rmSync(paths.backupsDir, { recursive: true, force: true });
    const rerun = await run(paths, { now: LATER });
    assert.equal(rerun.changes, 0);
    const sets = listBackups(paths);
    assert.equal(sets.length, 1, "a set for the v1 manifest");
    const { index, dir } = readBackup(paths, sets[0]);
    assert.deepEqual(index.entries.map((entry) => entry.path), ["ai-agents-setup/manifest.json"]);
    assert.equal(fs.readFileSync(path.join(dir, "files", "config", "ai-agents-setup", "manifest.json"), "utf8"), v1Text);
    assert.equal(readManifest(paths).data.migratedFromV1.backup, sets[0]);
  });

  test("migration writes settings.json before it removes the v1 hooks it points at", async (t) => {
    const { paths } = setup(t);
    const order = [];
    const realUnlink = fs.unlinkSync.bind(fs);
    const realRename = fs.renameSync.bind(fs);
    t.mock.method(fs, "unlinkSync", (file) => {
      order.push(`remove ${path.basename(String(file))}`);
      return realUnlink(file);
    });
    t.mock.method(fs, "renameSync", (from, to) => {
      order.push(`write ${path.basename(String(to))}`);
      return realRename(from, to);
    });
    await run(paths);
    const settings = order.indexOf("write settings.json");
    const gate = order.indexOf("remove gate.mjs");
    assert.ok(settings >= 0 && gate >= 0, order.join(", "));
    assert.ok(settings < gate, "settings.json is written first");
  });
});

describe("settings.json edited while the confirmation waits", () => {
  test("the edit survives: the migration is recomputed on the current file", async (t) => {
    const { paths } = setup(t);
    const io = captureIo();
    io.confirm = async () => {
      const live = JSON.parse(fs.readFileSync(paths.settingsFile, "utf8"));
      live.model = "claude-sonnet-5-5";
      live.permissions.allow = ["Bash(npm test:*)"];
      fs.writeFileSync(paths.settingsFile, JSON.stringify(live, null, "\t") + "\n");
      return true;
    };
    const result = await run(paths, { yes: false, interactive: true, io });
    assert.equal(result.code, 0);
    const after = readSettings(paths);
    assert.equal(after.model, "claude-sonnet-5-5", "the concurrent model change is kept");
    assert.deepEqual(after.permissions.allow, ["Bash(npm test:*)"], "the concurrent allow rule is kept");
    assert.equal(allHandlers(after).some((handler) => pointsIntoV1Hooks(handler, paths.appDir)), false, "the v1 handlers are still removed");
    assert.match(result.io.text(), /settings\.json changed while waiting for the answer; the migration was recomputed/);
  });
});

describe("backup copies keep secrets owner-only", () => {
  test("a 0600 settings.json is copied 0600 into a 0700 set, by install and by restore", { skip: process.platform === "win32" }, async (t) => {
    const { paths } = setup(t);
    fs.chmodSync(paths.settingsFile, 0o600);
    await run(paths);
    const [migrationSet] = listBackups(paths);
    const copy = path.join(paths.backupsDir, migrationSet, "files", "config", "settings.json");
    assert.equal(fs.statSync(copy).mode & 0o077, 0, "the migration copy is owner-only");
    assert.equal(fs.statSync(path.join(paths.backupsDir, migrationSet)).mode & 0o077, 0, "the set folder is owner-only");
    assert.equal(readBackup(paths, migrationSet).index.entries.find((entry) => entry.path === "settings.json").mode, "600");
    fs.chmodSync(paths.settingsFile, 0o600);
    const restored = await restore({ paths, yes: true, io: captureIo(), now: LATER });
    assert.equal(restored.code, 0);
    assert.equal(fs.statSync(paths.settingsFile).mode & 0o777, 0o600, "restore keeps the recorded mode");
    const preRestore = restored.backup.stamp;
    const second = path.join(paths.backupsDir, preRestore, "files", "config", "settings.json");
    assert.equal(fs.statSync(second).mode & 0o077, 0, "the pre-restore copy is owner-only");
  });
});

describe("uninstall and reinstall after a v1 migration", () => {
  test("one rule file loads, adopted and migratedFromV1 come back, and the migration set is kept", async (t) => {
    const { paths } = setup(t);
    await run(paths);
    const migrationSet = readManifest(paths).data.migratedFromV1.backup;
    const adoptedSha = readManifest(paths).data.adopted[0].sha256;
    for (let i = 1; i <= 4; i += 1) {
      const removed = await uninstall({ paths, yes: true, io: captureIo(), now: new Date(Date.UTC(2026, 9, 28, 13, i, 0)) });
      assert.equal(removed.code, 0);
      assert.equal(fs.existsSync(path.join(paths.rulesDir, "house-rules.md")), true, "uninstall puts the original back");
      const again = await run(paths, { now: new Date(Date.UTC(2026, 9, 28, 13, i, 30)) });
      assert.equal(again.code, 0);
      assert.deepEqual(fs.readdirSync(paths.rulesDir).sort(), ["wf-house-rules.md"], `round ${i}: only the wf rule file loads`);
      const data = readManifest(paths).data;
      assert.deepEqual(data.adopted, [{ path: "rules/house-rules.md", sha256: adoptedSha }], `round ${i}: adopted is recorded again`);
      assert.equal(data.migratedFromV1?.backup, migrationSet, `round ${i}: the migration record comes back`);
    }
    assert.ok(listBackups(paths).includes(migrationSet), "the migration set survives the cycles");
  });

  test("a live house-rules.md that differs from the adopted original is left alone with a note", async (t) => {
    const { paths } = setup(t);
    await run(paths);
    await uninstall({ paths, yes: true, io: captureIo(), now: LATER });
    fs.writeFileSync(path.join(paths.rulesDir, "house-rules.md"), "my newer rules\n");
    const again = await run(paths, { now: new Date("2026-10-28T12:40:00Z") });
    assert.equal(fs.readFileSync(path.join(paths.rulesDir, "house-rules.md"), "utf8"), "my newer rules\n");
    assert.match(again.io.text(), /note: rules\/house-rules\.md differs from the adopted original; it is left as it is/);
  });
});

describe("migrateSettings", () => {
  const appDir = "/c/ai-agents-setup";
  const v1 = {
    settings: {
      prior: { "/env/CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": { present: false } },
      containers: ["/env", "/permissions/deny", "/hooks"],
      deny: [
        { rule: "Agent(model:*)", preexisting: false },
        { rule: "Agent(effort:*)", preexisting: true }
      ]
    }
  };

  test("keeps preexisting deny rules, user handlers in a shared group and containers v1 did not create", () => {
    const input = {
      permissions: { deny: ["Agent(model:*)", "Agent(effort:*)", "Bash(rm *)"] },
      env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "/n", args: ["/c/ai-agents-setup/hooks/gate.mjs"] },
              { type: "command", command: "/usr/local/bin/mine.sh" }
            ]
          }
        ],
        Stop: [{ hooks: [{ type: "command", command: '"/n" "/c/ai-agents-setup/hooks/stop.mjs"' }] }]
      }
    };
    const result = migrateSettings({ text: JSON.stringify(input, null, 2) + "\n", v1, appDir, platform: "linux" });
    assert.deepEqual(result.data.permissions.deny, ["Agent(effort:*)", "Bash(rm *)"]);
    assert.deepEqual(result.data.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] }]);
    assert.equal(result.data.hooks.Stop, undefined, "the quoted command string form is recognised");
    assert.equal(result.data.env, undefined, "env emptied and pruned: v1 created it");
    assert.equal(result.indent, "  ");
    assert.ok(result.text.startsWith('{\n  "permissions"'));
  });

  test("an env that v1 did not create stays even when empty", () => {
    const own = { settings: { ...v1.settings, containers: [] } };
    const result = migrateSettings({ text: '{\n\t"env": {\n\t\t"CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"\n\t}\n}\n', v1: own, appDir, platform: "linux" });
    assert.deepEqual(result.data.env, {});
    assert.equal(result.text, '{\n\t"env": {}\n}\n');
  });

  test("a spawn depth that existed before v1 is kept", () => {
    const own = { settings: { prior: { "/env/CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": { present: true, value: "2" } } } };
    const result = migrateSettings({ text: '{\n\t"env": {\n\t\t"CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1"\n\t}\n}\n', v1: own, appDir, platform: "linux" });
    assert.equal(result.changed, false);
    assert.equal(result.data.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "1");
  });

  test("handlers of other tools are never touched", () => {
    const text = '{\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t{\n\t\t\t\t"matcher": "Bash",\n\t\t\t\t"hooks": [\n\t\t\t\t\t{\n\t\t\t\t\t\t"type": "command",\n\t\t\t\t\t\t"command": "/n",\n\t\t\t\t\t\t"args": ["/c/other-tool/hooks/gate.mjs"]\n\t\t\t\t\t}\n\t\t\t\t]\n\t\t\t}\n\t\t]\n\t}\n}\n';
    const result = migrateSettings({ text, v1, appDir, platform: "linux" });
    assert.equal(result.changed, false);
    assert.equal(result.text, text);
  });

  test("expanded arrays stay expanded when the file uses them", () => {
    const text = '{\n  "permissions": {\n    "deny": [\n      "Agent(model:*)",\n      "Bash(rm *)"\n    ]\n  }\n}\n';
    const result = migrateSettings({ text, v1, appDir, platform: "linux" });
    assert.equal(result.text, '{\n  "permissions": {\n    "deny": [\n      "Bash(rm *)"\n    ]\n  }\n}\n');
    assert.equal(result.lossless, true);
  });

  test("windows handler paths with backslashes are recognised", () => {
    const handler = { type: "command", command: "C:\\node.exe", args: ["C:\\Users\\a\\.claude\\ai-agents-setup\\hooks\\gate.mjs"] };
    assert.equal(pointsIntoV1Hooks(handler, "C:\\Users\\a\\.claude\\ai-agents-setup", "win32"), true);
    assert.equal(pointsIntoV1Hooks(handler, "C:\\Users\\b\\.claude\\ai-agents-setup", "win32"), false);
  });
});
