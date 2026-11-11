import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createGuard, listBackups, readBackup, readManifest, sha256, writeManifest } from "../lib/core.mjs";
import { NEXT_HINT, diff, install, migrationBlock, planFiles, planLines, prepareInstall, reportLines, restore, uninstall } from "../lib/apply.mjs";
import { migrationLines } from "../lib/migrate.mjs";
import { createUi, stripAnsi, visibleLength } from "../lib/ui.mjs";
import { captureIo, cleanup, fakeBuild, fakeSelection, installV1Fixture, makePaths, snapshot, tmpRoot } from "./data/install/helpers.mjs";

const NOW = new Date("2026-10-28T12:00:00Z");
const LATER = new Date("2026-10-28T12:05:00Z");
const POSIX = process.platform !== "win32";

function setup(t) {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const paths = makePaths(root);
  return { root, paths };
}

function run(paths, build, extra = {}) {
  const io = extra.io ?? captureIo();
  return install({
    paths,
    build,
    selection: fakeSelection(),
    skills: ["seo"],
    repoRoot: "/repo",
    nodePath: process.execPath,
    claudeVersion: "2.1.312",
    env: { PATH: extra.pathEnv ?? paths.launcherDir },
    yes: true,
    io,
    now: NOW,
    ...extra,
    io
  }).then((result) => ({ ...result, io }));
}

describe("install", () => {
  test("a fresh install writes every file, the manifest and a backup set of creates", async (t) => {
    const { paths } = setup(t);
    const build = fakeBuild(paths);
    const result = await run(paths, build);
    assert.equal(result.code, 0);
    assert.equal(result.changes, build.files.length);
    for (const file of build.files) {
      const target = path.join(file.base === "launcher" ? paths.launcherDir : paths.configHome, file.path);
      assert.equal(fs.readFileSync(target, "utf8"), file.content, `content of ${file.path}`);
      if (POSIX) assert.equal(fs.statSync(target).mode & 0o777, file.mode, `mode of ${file.path}`);
    }
    const manifest = readManifest(paths).data;
    assert.equal(manifest.schema, "wf.manifest/2");
    assert.equal(manifest.files.length, build.files.length);
    assert.equal(manifest.files.find((entry) => entry.path === "wf").mode, "755");
    assert.equal(manifest.files[0].sha256, sha256(build.files[0].content));
    assert.deepEqual(manifest.skills, { known: ["seo"], selection: fakeSelection() });
    assert.equal(manifest.claudeVersion, "2.1.312");
    assert.equal(manifest.agents.length, build.agents.length);
    const sets = listBackups(paths);
    assert.equal(sets.length, 1);
    const { index } = readBackup(paths, sets[0]);
    assert.ok(index.entries.every((entry) => entry.sha256 === null), "nothing existed before, so every entry is a create");
    assert.match(result.io.text(), /Plan: \d+ create, 0 update, 0 remove, 0 unchanged/);
    assert.match(result.io.text(), /verify: \d+ files match/);
  });

  test("the manifest saves the install choices next to the skills answer", async (t) => {
    const { paths } = setup(t);
    const choices = { tiers: ["t1"], roles: ["coder"], models: ["claude-haiku-5-5"], known: { tiers: ["t1", "t2", "t3"], roles: ["coder", "docs"], models: ["claude-haiku-5-5"] } };
    await run(paths, fakeBuild(paths), { choices });
    const manifest = readManifest(paths).data;
    assert.deepEqual(manifest.choices, choices);
    assert.deepEqual(Object.keys(manifest).slice(Object.keys(manifest).indexOf("choices"), Object.keys(manifest).indexOf("choices") + 2), ["choices", "skills"]);
    const again = await run(paths, fakeBuild(paths), { choices: { ...choices, tiers: ["t1", "t2"] }, now: LATER });
    assert.match(again.io.text(), /0 changes: wf is up to date \(manifest refreshed\)\./, "a changed answer alone refreshes the manifest");
    assert.deepEqual(readManifest(paths).data.choices.tiers, ["t1", "t2"]);
  });

  test("without choices the manifest has no choices key", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    assert.equal(Object.hasOwn(readManifest(paths).data, "choices"), false);
  });

  test("a good install ends with the next step, and announced skips the plan already shown", async (t) => {
    const { paths } = setup(t);
    const result = await run(paths, fakeBuild(paths), { announced: true });
    assert.equal(result.io.lines.at(-1), NEXT_HINT);
    assert.ok(!result.io.text().includes("Plan: "), "the summary showed the plan already");
    assert.match(result.io.text(), /Applied \d+ changes\. Backup: /);
  });

  test("a rich terminal shows the plan with icons and the results with check marks", async (t) => {
    const { paths } = setup(t);
    const ui = createUi({ rich: true, unicode: true, color: true, columns: 120 });
    const result = await run(paths, fakeBuild(paths), { ui });
    const text = stripAnsi(result.io.text());
    assert.match(text, /^ {2}Plan {2}\d+ create \u00b7 0 update \u00b7 0 remove \u00b7 0 unchanged$/m);
    assert.match(text, /^ {4}\u271a create {2}ai-agents-setup\/plugin\/agents\/ \(4 files\)$/m);
    assert.match(text, /^ {2}\u2714 Applied \d+ changes\. Backup: \d{8}T\d{6}Z \(node wf\.mjs restore puts it back\)\.$/m);
    assert.match(text, /^ {2}\u2714 verify: \d+ files match\.$/m);
    assert.match(text, /^ {2}Next: run wf in a project folder\.$/m);
    assert.ok(result.io.text().includes("\u001b[32m"), "green check marks");
    const ascii = createUi({ rich: true, unicode: false, color: false, columns: 120 });
    const lines = planLines(paths, planFiles({ paths, build: fakeBuild(paths, { agentBody: "changed" }) }), ascii);
    assert.match(lines[0], /^ {2}Plan {2}0 create, 4 update, 0 remove, \d+ unchanged$/);
    assert.ok(lines.slice(1).every((line) => line.startsWith("    ~ update  ai-agents-setup/plugin/agents/")), JSON.stringify(lines));
  });

  test("the v1 migration block wraps every line inside the margin at 60 and 80 columns", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = installV1Fixture(root);
    const prepared = prepareInstall({ paths, build: fakeBuild(paths) });
    assert.ok(prepared.migration, "the v1 fixture plans a migration");
    for (const columns of [60, 80]) {
      for (const unicode of [true, false]) {
        const ui = createUi({ rich: true, unicode, color: true, columns });
        const lines = migrationBlock(prepared.migration, ui);
        assert.ok(lines.length > 3);
        for (const line of lines) assert.ok(visibleLength(line) <= columns - 1, `${columns} columns: ${JSON.stringify(stripAnsi(line))}`);
        assert.ok(lines.slice(1).every((line) => line.startsWith("    ")), "the block lines sit inside the margin under the warning");
        const body = lines.map((line) => stripAnsi(line).trim()).join(" ");
        assert.ok(body.includes("settings.json: remove"), body);
      }
    }
    assert.deepEqual(migrationBlock(prepared.migration), migrationLines(prepared.migration), "plain output is unchanged");
  });

  test("reportLines puts the notes and the plan together for the summary screen", async (t) => {
    const { paths } = setup(t);
    const prepared = prepareInstall({ paths, build: fakeBuild(paths) });
    const lines = reportLines(paths, { ...prepared, notes: ["a note"] });
    assert.equal(lines[0], "note: a note");
    assert.match(lines[1], /^Plan: \d+ create, 0 update, 0 remove, 0 unchanged$/);
  });

  test("a second install reports 0 changes, writes nothing and makes no backup", async (t) => {
    const { paths } = setup(t);
    const build = fakeBuild(paths);
    await run(paths, build);
    const before = fs.readFileSync(paths.manifestFile, "utf8");
    const second = await run(paths, build, { now: LATER });
    assert.equal(second.code, 0);
    assert.equal(second.changes, 0);
    assert.match(second.io.text(), /0 changes: wf is up to date\./);
    assert.equal(fs.readFileSync(paths.manifestFile, "utf8"), before);
    assert.equal(listBackups(paths).length, 1);
  });

  test("a changed source updates only that file and backs up the old content", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const result = await run(paths, fakeBuild(paths, { agentBody: "new body" }), { now: LATER });
    assert.equal(result.changes, 4);
    assert.match(result.io.text(), /4 update/);
    const sets = listBackups(paths);
    const { index, dir } = readBackup(paths, sets[sets.length - 1]);
    const entry = index.entries.find((item) => item.path === "ai-agents-setup/plugin/agents/coder-t1.md");
    assert.equal(entry.action, "update");
    assert.match(fs.readFileSync(path.join(dir, "files", "config", ...entry.path.split("/")), "utf8"), /^---[\s\S]*body coder-t1/);
  });

  test("a file the user changed is updated and flagged as changed since the last install", async (t) => {
    const { paths } = setup(t);
    const build = fakeBuild(paths);
    await run(paths, build);
    fs.appendFileSync(path.join(paths.configHome, "rules", "wf-house-rules.md"), "my edit\n");
    const result = await run(paths, build, { now: LATER });
    assert.equal(result.changes, 1);
    assert.match(result.io.text(), /update {2}rules\/wf-house-rules\.md \(changed since the last install\)/);
    assert.equal(fs.readFileSync(path.join(paths.configHome, "rules", "wf-house-rules.md"), "utf8"), build.files.find((file) => file.path === "rules/wf-house-rules.md").content);
  });

  test("a file dropped from the build is removed with its empty folder", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const result = await run(paths, fakeBuild(paths, { omit: ["ai-agents-setup/plugin/library/seo/SKILL.md"] }), { now: LATER });
    assert.equal(result.changes, 1);
    assert.match(result.io.text(), /remove {2}ai-agents-setup\/plugin\/library\/seo\/SKILL\.md/);
    assert.equal(fs.existsSync(path.join(paths.pluginDir, "library")), false);
    assert.equal(readManifest(paths).data.files.some((entry) => entry.path.includes("library")), false);
  });

  test("a mode change alone is an update", { skip: !POSIX }, async (t) => {
    const { paths } = setup(t);
    const build = fakeBuild(paths);
    await run(paths, build);
    fs.chmodSync(path.join(paths.launcherDir, "wf"), 0o644);
    const actions = planFiles({ paths, build });
    assert.equal(actions.find((item) => item.path === "wf").action, "update");
  });

  test("--dry-run shows the plan and writes nothing", async (t) => {
    const { root, paths } = setup(t);
    const result = await run(paths, fakeBuild(paths), { dryRun: true });
    assert.equal(result.code, 0);
    assert.match(result.io.text(), /Dry run: \d+ changes, nothing written\./);
    assert.deepEqual(snapshot(root), {});
  });

  test("a declined confirmation writes nothing and exits 1", async (t) => {
    const { root, paths } = setup(t);
    const io = captureIo({ answer: false });
    const result = await run(paths, fakeBuild(paths), { yes: false, interactive: true, io });
    assert.equal(result.code, 1);
    assert.equal(io.questions.length, 1);
    assert.match(io.questions[0], /^Apply \d+ changes\?$/);
    assert.deepEqual(snapshot(root), {});
  });

  test("no terminal means no confirmation", async (t) => {
    const { paths } = setup(t);
    const io = captureIo({ answer: false });
    const result = await run(paths, fakeBuild(paths), { yes: false, interactive: false, io });
    assert.equal(result.code, 0);
    assert.equal(io.questions.length, 0);
  });

  test("a plugin validate failure is reported, not rolled back, and exits 1", async (t) => {
    const { paths } = setup(t);
    const build = fakeBuild(paths);
    const result = await run(paths, build, { validate: () => ({ ran: true, ok: false, detail: "claude plugin validate failed: bad" }) });
    assert.equal(result.code, 1);
    assert.match(result.io.text(), /verify: claude plugin validate failed: bad \(not rolled back\)/);
    assert.equal(fs.existsSync(path.join(paths.pluginDir, "agents", "coder-t1.md")), true);
  });

  test("a passing plugin validate is printed", async (t) => {
    const { paths } = setup(t);
    const seen = [];
    const result = await run(paths, fakeBuild(paths), { validate: (dir) => (seen.push(dir), { ran: true, ok: true, detail: "claude plugin validate passed" }) });
    assert.equal(result.code, 0);
    assert.deepEqual(seen, [paths.pluginDir]);
    assert.match(result.io.text(), /verify: claude plugin validate passed/);
  });

  test("prints a PATH hint only when the launcher folder is not on PATH", async (t) => {
    const { paths } = setup(t);
    const off = await run(paths, fakeBuild(paths), { pathEnv: "/usr/bin" });
    assert.match(off.io.text(), /is not on PATH/);
    const on = await run(paths, fakeBuild(paths), { now: LATER });
    assert.doesNotMatch(on.io.text(), /is not on PATH/);
  });

  test("an unknown manifest schema stops the install", async (t) => {
    const { paths } = setup(t);
    writeManifest(paths, { schema: "wf.manifest/9" }, createGuard(paths));
    await assert.rejects(run(paths, fakeBuild(paths)), /unknown manifest schema/);
  });

  test("the migration record and adopted list survive later installs", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const manifest = readManifest(paths).data;
    manifest.migratedFromV1 = { backup: "20261028T110000Z" };
    manifest.adopted = [{ path: "rules/house-rules.md", sha256: "x" }];
    writeManifest(paths, manifest, createGuard(paths));
    await run(paths, fakeBuild(paths, { agentBody: "changed" }), { now: LATER });
    const after = readManifest(paths).data;
    assert.deepEqual(after.migratedFromV1, { backup: "20261028T110000Z" });
    assert.deepEqual(after.adopted, [{ path: "rules/house-rules.md", sha256: "x" }]);
  });
});

describe("diff", () => {
  test("lists changes with line counts and writes nothing", async (t) => {
    const { root, paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const before = snapshot(root);
    const io = captureIo();
    const result = diff({ paths, build: fakeBuild(paths, { agentBody: "two\nlines", extra: [{ base: "config", path: "ai-agents-setup/plugin/agents/new.md", content: "a\nb\n", mode: 0o644 }] }), io });
    assert.equal(result.code, 0);
    assert.equal(result.changes, 5);
    assert.match(io.text(), /update {2}ai-agents-setup\/plugin\/agents\/coder-t1\.md \(\+2 -1 lines\)/);
    assert.match(io.text(), /create {2}ai-agents-setup\/plugin\/agents\/new\.md \(3 lines\)/);
    assert.deepEqual(snapshot(root), before);
  });

  test("reports 0 changes when up to date", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const io = captureIo();
    assert.equal(diff({ paths, build: fakeBuild(paths), io }).changes, 0);
    assert.match(io.text(), /0 changes/);
  });
});

describe("uninstall and restore", () => {
  test("uninstall backs up and removes everything wf installed, keeps backups and adopted", async (t) => {
    const { paths } = setup(t);
    const build = fakeBuild(paths);
    await run(paths, build);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(paths.stateDir, "s1.json"), "{}");
    fs.writeFileSync(path.join(paths.stateDir, "hook-errors.log"), "x\n");
    fs.writeFileSync(path.join(paths.pluginDir, "agents", "stray.md"), "stray\n");
    fs.mkdirSync(path.join(paths.adoptedDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(paths.adoptedDir, "agents", "Explore.md"), "original\n");
    const io = captureIo();
    const result = await uninstall({ paths, yes: true, io, now: LATER });
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(paths.pluginDir), false);
    assert.equal(fs.existsSync(paths.stateDir), false);
    assert.equal(fs.existsSync(paths.manifestFile), false);
    assert.equal(fs.existsSync(path.join(paths.appDir, "wf-settings.json")), false);
    assert.equal(fs.existsSync(path.join(paths.launcherDir, "wf")), false);
    assert.equal(fs.existsSync(path.join(paths.configHome, "rules", "wf-house-rules.md")), false);
    assert.equal(fs.existsSync(path.join(paths.adoptedDir, "agents", "Explore.md")), true);
    assert.equal(listBackups(paths).length, 2);
    const { index } = readBackup(paths, listBackups(paths)[1]);
    assert.equal(index.command, "uninstall");
    const backedUp = index.entries.map((entry) => entry.path);
    for (const rel of ["ai-agents-setup/plugin/agents/stray.md", "ai-agents-setup/state/s1.json", "ai-agents-setup/state/hook-errors.log", "ai-agents-setup/manifest.json", "wf"]) assert.ok(backedUp.includes(rel), `${rel} is backed up`);
  });

  test("uninstall restores the adopted rules/house-rules.md when it is absent", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    fs.mkdirSync(path.join(paths.adoptedDir, "rules"), { recursive: true });
    fs.writeFileSync(path.join(paths.adoptedDir, "rules", "house-rules.md"), "my rules\n");
    const io = captureIo();
    await uninstall({ paths, yes: true, io, now: LATER });
    assert.equal(fs.readFileSync(path.join(paths.rulesDir, "house-rules.md"), "utf8"), "my rules\n");
    assert.match(io.text(), /restored rules\/house-rules\.md/);
  });

  test("uninstall leaves an existing different rules/house-rules.md alone", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    fs.mkdirSync(path.join(paths.adoptedDir, "rules"), { recursive: true });
    fs.writeFileSync(path.join(paths.adoptedDir, "rules", "house-rules.md"), "my rules\n");
    fs.writeFileSync(path.join(paths.rulesDir, "house-rules.md"), "newer rules\n");
    const io = captureIo();
    await uninstall({ paths, yes: true, io, now: LATER });
    assert.equal(fs.readFileSync(path.join(paths.rulesDir, "house-rules.md"), "utf8"), "newer rules\n");
    assert.match(io.text(), /left as it is/);
  });

  test("uninstall without a manifest does nothing; a v1 install asks for install first", async (t) => {
    const { paths } = setup(t);
    const io = captureIo();
    assert.equal((await uninstall({ paths, yes: true, io })).code, 0);
    assert.match(io.text(), /not installed/);
    writeManifest(paths, { schema: "wf.manifest/1", files: [] }, createGuard(paths));
    const io2 = captureIo();
    assert.equal((await uninstall({ paths, yes: true, io: io2 })).code, 1);
    assert.match(io2.text(), /v1 install is present/);
  });

  test("a declined uninstall removes nothing", async (t) => {
    const { root, paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const before = snapshot(root);
    const result = await uninstall({ paths, interactive: true, io: captureIo({ answer: false }) });
    assert.equal(result.code, 1);
    assert.deepEqual(snapshot(root), before);
  });

  test("restore after uninstall brings every file back byte for byte", async (t) => {
    const { root, paths } = setup(t);
    await run(paths, fakeBuild(paths));
    fs.mkdirSync(path.join(paths.adoptedDir, "rules"), { recursive: true });
    fs.writeFileSync(path.join(paths.adoptedDir, "rules", "house-rules.md"), "my rules\n");
    const before = snapshot(root);
    await uninstall({ paths, yes: true, io: captureIo(), now: LATER });
    const io = captureIo();
    const result = await restore({ paths, yes: true, io, now: new Date("2026-10-28T12:10:00Z") });
    assert.equal(result.code, 0);
    const after = snapshot(root);
    for (const [rel, text] of Object.entries(before)) assert.equal(after[rel], text, `${rel} restored`);
    assert.equal(after["config/rules/house-rules.md"], undefined, "the house rules restored by uninstall are removed again");
    if (POSIX) assert.equal(fs.statSync(path.join(paths.launcherDir, "wf")).mode & 0o777, 0o755);
  });

  test("restore --to picks a set; an unknown stamp is a usage error", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    await run(paths, fakeBuild(paths, { agentBody: "v2" }), { now: LATER });
    const sets = listBackups(paths);
    const io = captureIo();
    const result = await restore({ paths, to: sets[0], yes: true, io, now: new Date("2026-10-28T12:10:00Z") });
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(path.join(paths.pluginDir, "agents", "coder-t1.md")), false, "the first set recorded creates, so restoring it removes them");
    const bad = await restore({ paths, to: "20200101T000000Z", yes: true, io: captureIo() });
    assert.equal(bad.code, 2);
  });

  test("uninstall without --yes and without a terminal is a preview that removes nothing", async (t) => {
    const { root, paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const before = snapshot(root);
    const io = captureIo();
    const result = await uninstall({ paths, interactive: false, io, now: LATER });
    assert.equal(result.code, 1);
    assert.equal(io.questions.length, 0);
    assert.match(io.text(), /remove \d+ files/);
    assert.match(io.text(), /No terminal to ask in: rerun with --yes\.\nNothing removed\./);
    assert.deepEqual(snapshot(root), before);
  });

  test("restore without --yes and without a terminal is a preview that writes nothing", async (t) => {
    const { root, paths } = setup(t);
    await run(paths, fakeBuild(paths));
    await uninstall({ paths, yes: true, io: captureIo(), now: LATER });
    const before = snapshot(root);
    const io = captureIo();
    const result = await restore({ paths, interactive: false, io, now: new Date("2026-10-28T12:10:00Z") });
    assert.equal(result.code, 1);
    assert.match(io.text(), /put back \d+ files/);
    assert.match(io.text(), /No terminal to ask in: rerun with --yes\.\nNothing restored\./);
    assert.deepEqual(snapshot(root), before);
  });

  test("uninstall never touches settings.json, Explore.md or the user's own agents and skills", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    const user = {
      "settings.json": '{\n\t"model": "claude-opus-5-5",\n\t"permissions": {\n\t\t"deny": ["Bash(rm *)"]\n\t}\n}\n',
      "agents/Explore.md": "---\nname: Explore\n---\n\nMy explore.\n",
      "agents/mine.md": "---\nname: mine\n---\n\nMine.\n",
      "skills/x/SKILL.md": "---\nname: x\n---\n\nSkill.\n"
    };
    for (const [rel, text] of Object.entries(user)) {
      const file = path.join(paths.configHome, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const result = await uninstall({ paths, yes: true, io: captureIo(), now: LATER });
    assert.equal(result.code, 0);
    for (const [rel, text] of Object.entries(user)) assert.equal(fs.readFileSync(path.join(paths.configHome, ...rel.split("/")), "utf8"), text, `${rel} is unchanged`);
    const backedUp = readBackup(paths, result.backup.stamp).index.entries.map((entry) => entry.path);
    for (const rel of Object.keys(user)) assert.ok(!backedUp.includes(rel), `${rel} is not an uninstall target`);
  });

  test("restore with no backups exits 1", async (t) => {
    const { paths } = setup(t);
    const io = captureIo();
    assert.equal((await restore({ paths, yes: true, io })).code, 1);
    assert.match(io.text(), /No backup sets/);
  });

  test("restore reads a v1 backup set and skips entries outside the wf paths", async (t) => {
    const { paths } = setup(t);
    const dir = path.join(paths.backupsDir, "20261019T122159Z");
    const copy = (base, rel, text) => {
      const file = path.join(dir, "files", base, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    copy("config", "agents/wf-coder.md", "v1 coder\n");
    copy("config", "skills/x/SKILL.md", "skill\n");
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({
        schema: "wf.backup/1",
        stamp: "20261019T122159Z",
        command: "install",
        entries: [
          { base: "config", path: "agents/wf-coder.md", sha256: sha256("v1 coder\n"), action: "update" },
          { base: "config", path: "skills/x/SKILL.md", sha256: sha256("skill\n"), action: "update" },
          { base: "config", path: "agents/wf-git.md", sha256: null, action: "create" }
        ]
      })
    );
    fs.mkdirSync(paths.agentsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.agentsDir, "wf-git.md"), "git\n");
    const io = captureIo();
    const result = await restore({ paths, yes: true, io, now: LATER });
    assert.equal(result.code, 1, "a skipped entry is a problem");
    assert.equal(fs.readFileSync(path.join(paths.agentsDir, "wf-coder.md"), "utf8"), "v1 coder\n");
    assert.equal(fs.existsSync(path.join(paths.agentsDir, "wf-git.md")), false);
    assert.equal(fs.existsSync(path.join(paths.configHome, "skills")), false);
    assert.match(io.text(), /skip skills\/x\/SKILL\.md: not a wf path/);
  });

  test("restore refuses a damaged backup copy", async (t) => {
    const { paths } = setup(t);
    await run(paths, fakeBuild(paths));
    await run(paths, fakeBuild(paths, { agentBody: "v2" }), { now: LATER });
    const sets = listBackups(paths);
    const { dir } = readBackup(paths, sets[1]);
    fs.writeFileSync(path.join(dir, "files", "config", "ai-agents-setup", "plugin", "agents", "coder-t1.md"), "tampered\n");
    const io = captureIo();
    const result = await restore({ paths, yes: true, io, now: new Date("2026-10-28T12:10:00Z") });
    assert.equal(result.code, 1);
    assert.match(io.text(), /coder-t1\.md: the backup copy is missing or damaged/);
    assert.match(fs.readFileSync(path.join(paths.pluginDir, "agents", "coder-t1.md"), "utf8"), /v2 coder-t1/);
  });
});
