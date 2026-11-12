import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".githooks");
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);
const STUB = `import fs from "node:fs";
const name = process.argv[2];
fs.appendFileSync("calls.log", \`\${name}\\n\`);
process.exitCode = fs.existsSync(\`fail-\${name}\`) ? 1 : 0;
`;

function git(cwd, args, env = {}) {
	return spawnSync("git", ["-c", "user.name=wf-test", "-c", "user.email=wf-test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env }
	});
}

function makeRepo({ initialCommit = true } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-hook-")));
	const init = git(dir, ["init", "-q"]);
	assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
		name: "hook-fixture",
		private: true,
		scripts: { lint: "node stub.mjs lint", test: "node stub.mjs test" }
	}, null, 2));
	fs.writeFileSync(path.join(dir, "stub.mjs"), STUB);
	if (initialCommit) {
		git(dir, ["add", "-A"]);
		const base = git(dir, ["commit", "-q", "--no-verify", "-m", "base"]);
		assert.equal(base.status, 0, `base commit failed: ${base.stderr}`);
	}
	return dir;
}

function writeFile(dir, rel, text) {
	const target = path.join(dir, ...rel.split("/"));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}

function stage(dir, ...files) {
	const result = git(dir, ["add", ...files]);
	assert.equal(result.status, 0, `git add failed: ${result.stderr}`);
}

function commit(dir, env = {}) {
	return git(dir, [
		"-c", `core.hooksPath=${HOOKS_DIR}`,
		"-c", "commit.gpgsign=false",
		"commit", "-q", "-m", "change"
	], { SKIP_TESTS: "", ...env });
}

function commitCount(dir) {
	const result = git(dir, ["rev-list", "--count", "HEAD"]);
	return result.status === 0 ? Number(result.stdout.trim()) : 0;
}

function callsLog(dir) {
	const file = path.join(dir, "calls.log");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function withRepo(options, fn) {
	return async () => {
		const dir = makeRepo(options);
		try {
			await fn(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
}

describe("pre-commit hook", () => {
	test("commits when the staged text is clean and lint and tests pass", withRepo({}, (dir) => {
		writeFile(dir, "notes.md", "plain text\n");
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.equal(result.status, 0, `commit with clean text is blocked: ${result.stderr}`);
		assert.equal(commitCount(dir), 2, "a clean commit adds one commit to the base");
		assert.equal(callsLog(dir), "lint\ntest\n", "lint runs before tests on a clean commit");
	}));

	test("blocks a commit that adds an em dash and names the file and line", withRepo({}, (dir) => {
		writeFile(dir, "notes.md", `first line\nsome ${EM_DASH} text\n`);
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.notEqual(result.status, 0, "a commit adding an em dash is not blocked");
		assert.match(result.stderr, /notes\.md:2: em or en dash in added line/, "the finding does not name notes.md line 2");
		assert.equal(commitCount(dir), 1, "a blocked commit still created a commit");
		assert.equal(callsLog(dir), null, "checks ran although the text check failed");
	}));

	test("blocks a commit that adds an en dash and names the file and line", withRepo({}, (dir) => {
		writeFile(dir, "notes.md", `first line\nrange 1${EN_DASH}2\n`);
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.notEqual(result.status, 0, "a commit adding an en dash is not blocked");
		assert.match(result.stderr, /notes\.md:2: em or en dash in added line/, "the finding does not name notes.md line 2");
		assert.equal(commitCount(dir), 1, "a blocked commit still created a commit");
		assert.equal(callsLog(dir), null, "checks ran although the text check failed");
	}));

	test("allows a commit that only removes a line with a dash", withRepo({}, (dir) => {
		writeFile(dir, "notes.md", `keep\nold ${EM_DASH} line\n`);
		stage(dir, "notes.md");
		const base = git(dir, ["commit", "-q", "--no-verify", "-m", "dash line"]);
		assert.equal(base.status, 0, `setup commit failed: ${base.stderr}`);
		writeFile(dir, "notes.md", "keep\n");
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.equal(result.status, 0, `removing a dash line is blocked: ${result.stderr}`);
		assert.equal(commitCount(dir), 3, "the removal commit was not created");
	}));

	test("blocks a commit that adds a conflict marker line", withRepo({}, (dir) => {
		writeFile(dir, "notes.md", "intro\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\n");
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.notEqual(result.status, 0, "a commit adding conflict markers is not blocked");
		assert.match(result.stderr, /notes\.md:2: conflict marker in added line/, "the finding does not name notes.md line 2");
		assert.equal(commitCount(dir), 1, "a blocked commit still created a commit");
	}));

	test("blocks a commit that stages a file under .work/", withRepo({}, (dir) => {
		writeFile(dir, ".work/notes.md", "task notes\n");
		stage(dir, "-f", ".work/notes.md");
		const result = commit(dir);
		assert.notEqual(result.status, 0, "a commit staging a .work/ file is not blocked");
		assert.match(result.stderr, /\.work\/notes\.md: staged task file under \.work\//, "the finding does not name the .work/ file");
		assert.equal(commitCount(dir), 1, "a blocked commit still created a commit");
	}));

	test("blocks a commit when lint fails and never runs the tests", withRepo({}, (dir) => {
		writeFile(dir, "fail-lint", "");
		writeFile(dir, "notes.md", "plain text\n");
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.notEqual(result.status, 0, "a commit with failing lint is not blocked");
		assert.equal(callsLog(dir), "lint\n", "tests ran after lint failed");
		assert.equal(commitCount(dir), 1, "a blocked commit still created a commit");
	}));

	test("blocks a commit when the tests fail after lint passes", withRepo({}, (dir) => {
		writeFile(dir, "fail-test", "");
		writeFile(dir, "notes.md", "plain text\n");
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.notEqual(result.status, 0, "a commit with failing tests is not blocked");
		assert.equal(callsLog(dir), "lint\ntest\n", "lint and tests did not both run before the block");
		assert.equal(commitCount(dir), 1, "a blocked commit still created a commit");
	}));

	test("SKIP_TESTS=1 lets a commit through despite failing lint and an em dash", withRepo({}, (dir) => {
		writeFile(dir, "fail-lint", "");
		writeFile(dir, "notes.md", `some ${EM_DASH} text\n`);
		stage(dir, "notes.md");
		const result = commit(dir, { SKIP_TESTS: "1" });
		assert.equal(result.status, 0, `SKIP_TESTS=1 does not skip the checks: ${result.stderr}`);
		assert.equal(callsLog(dir), null, "checks ran although SKIP_TESTS=1");
		assert.equal(commitCount(dir), 2, "the skipped commit was not created");
	}));

	test("commits the first change in an unborn repository when the text is clean", withRepo({ initialCommit: false }, (dir) => {
		writeFile(dir, "notes.md", "plain text\n");
		stage(dir, "notes.md");
		const result = commit(dir);
		assert.equal(result.status, 0, `first commit in an unborn repository is blocked: ${result.stderr}`);
		assert.equal(commitCount(dir), 1, "the first commit was not created");
		assert.equal(callsLog(dir), "lint\ntest\n", "lint and tests did not run on the first commit");
	}));
});
