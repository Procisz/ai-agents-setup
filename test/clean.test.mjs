import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clean } from "../scripts/wf-clean.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(REPO, "scripts", "wf-clean.mjs");

let tmp;
let counter = 0;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-clean-")));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function project({ tasks = { "20261028-1000-a": ["summary.md", "progress.md"] }, gitignore = true } = {}) {
  counter += 1;
  const root = path.join(tmp, `project-${counter}`);
  const work = path.join(root, ".work");
  fs.mkdirSync(work, { recursive: true });
  if (gitignore) fs.writeFileSync(path.join(work, ".gitignore"), "*\n");
  for (const [name, files] of Object.entries(tasks)) {
    fs.mkdirSync(path.join(work, name, "notes"), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(work, name, file), "x\n");
    fs.writeFileSync(path.join(work, name, "notes", "scratch.txt"), "y\n");
  }
  return { root, work };
}

describe("wf-clean refusals", () => {
  test("needs exactly one absolute path", () => {
    for (const argv of [[], ["a", "b"], [""], ["relative/.work/t"]]) {
      const result = clean(argv);
      assert.equal(result.code, 2, JSON.stringify(argv));
      assert.match(result.error, /^wf-clean: refused: /);
    }
  });

  test("refuses a path that does not exist or is a file", () => {
    const { work } = project();
    assert.match(clean([path.join(work, "missing")]).error, /does not exist/);
    assert.match(clean([path.join(work, ".gitignore")]).error, /not a folder/);
  });

  test("refuses folders that are not <project>/.work/<name>", () => {
    const { root, work } = project();
    fs.mkdirSync(path.join(root, "src", "t"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "t", "summary.md"), "x");
    for (const target of [root, work, path.join(root, "src", "t"), path.join(work, "20261028-1000-a", "notes")]) {
      assert.equal(clean([target]).code, 2, target);
    }
    assert.ok(fs.existsSync(path.join(work, "20261028-1000-a", "summary.md")));
  });

  test("refuses a task folder with neither summary.md nor progress.md", () => {
    const { work } = project({ tasks: { "20261028-1000-a": ["plan.md"] } });
    assert.match(clean([path.join(work, "20261028-1000-a")]).error, /neither summary\.md nor progress\.md/);
    assert.ok(fs.existsSync(path.join(work, "20261028-1000-a")));
  });

  test("judges a symlink by its real path", () => {
    const { root } = project();
    const outside = path.join(root, "keep");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "summary.md"), "x");
    const link = path.join(root, ".work", "link");
    fs.symlinkSync(outside, link, "dir");
    assert.match(clean([link]).error, /is not a task folder/);
    assert.ok(fs.existsSync(path.join(outside, "summary.md")));
  });
});

describe("wf-clean removal", () => {
  test("removes the task folder and .work when only .gitignore is left", () => {
    const { work } = project();
    const task = path.join(work, "20261028-1000-a");
    const result = clean([task]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.lines, [`wf-clean: removed ${task}`, `wf-clean: removed ${work}`]);
    assert.equal(fs.existsSync(work), false);
  });

  test("removes .work when nothing at all is left", () => {
    const { work } = project({ tasks: { t: ["progress.md"] }, gitignore: false });
    assert.equal(clean([path.join(work, "t")]).lines.length, 2);
    assert.equal(fs.existsSync(work), false);
  });

  test("keeps .work while another task is still there", () => {
    const { work } = project({ tasks: { a: ["summary.md"], b: ["progress.md"] } });
    const result = clean([path.join(work, "a")]);
    assert.deepEqual(result.lines, [`wf-clean: removed ${path.join(work, "a")}`]);
    assert.deepEqual(fs.readdirSync(work).sort(), [".gitignore", "b"]);
  });
});

describe("wf-clean and a task of another session", () => {
  function owned(session, ledgerAgeMinutes) {
    const { root, work } = project();
    const task = path.join(work, "20261028-1000-a");
    fs.writeFileSync(path.join(task, "progress.md"), `# a\nSession: ${session}\nTier: T1.\n`);
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Date.parse("2026-10-28T12:00:00Z");
    if (ledgerAgeMinutes !== null) fs.writeFileSync(path.join(stateDir, `${session}.json`), JSON.stringify({ sessionId: session, updatedAt: new Date(now - ledgerAgeMinutes * 60000).toISOString(), agents: {} }));
    return { task, options: { config: { stateDir }, now } };
  }

  test("refuses the folder of another session that is still active", () => {
    const { task, options } = owned("other-session", 10);
    const result = clean([task], { ...options, env: { CLAUDE_CODE_SESSION_ID: "my-session" } });
    assert.equal(result.code, 2);
    assert.match(result.error, /belongs to session other-session, which was active 10 min ago; it may still be running \(add --force to delete it anyway\)/);
    assert.equal(fs.existsSync(task), true);
  });

  test("removes its own folder, a folder whose session is long idle, and a live one with --force", () => {
    const mine = owned("my-session", 1);
    assert.equal(clean([mine.task], { ...mine.options, env: { CLAUDE_CODE_SESSION_ID: "my-session" } }).code, 0);
    const stale = owned("old-session", 120);
    assert.equal(clean([stale.task], { ...stale.options, env: { CLAUDE_CODE_SESSION_ID: "my-session" } }).code, 0);
    const forced = owned("other-session", 5);
    assert.equal(clean(["--force", forced.task], { ...forced.options, env: { CLAUDE_CODE_SESSION_ID: "my-session" } }).code, 0);
    assert.equal(fs.existsSync(forced.task), false);
  });
});

describe("wf-clean process", () => {
  test("prints what it removed and exits 0", () => {
    const { work } = project();
    const task = path.join(work, "20261028-1000-a");
    const result = spawnSync(process.execPath, [SCRIPT, task], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `wf-clean: removed ${task}\nwf-clean: removed ${work}\n`);
  });

  test("exits 2 with the reason on stderr when it refuses", () => {
    const { root } = project();
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^wf-clean: refused: .+ is not a task folder <project>\/\.work\/<name>\n$/);
    assert.ok(fs.existsSync(root));
  });
});
