import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF = path.join(REPO_ROOT, "wf.mjs");
const WINDOWS = process.platform === "win32";
const AGENTS = Object.freeze([
  "orchestrator",
  "planner-t1",
  "planner-t2",
  "planner-t3",
  "planner-t4",
  "planner-t5",
  "docs-t1",
  "docs-t2",
  "docs-t3",
  "docs-t4",
  "docs-t5",
  "coder-t1",
  "coder-t2",
  "coder-t3",
  "coder-t4",
  "coder-t5",
  "tester-t1",
  "tester-t2",
  "tester-t3",
  "tester-t4",
  "tester-t5",
  "reviewer-t1",
  "reviewer-t2",
  "reviewer-t3",
  "reviewer-t4",
  "reviewer-t5",
  "debugger-t1",
  "debugger-t2",
  "debugger-t3",
  "debugger-t4",
  "debugger-t5",
  "git"
]);
const SKILLS = Object.freeze([
  "accessibility",
  "code-review",
  "context-cache",
  "core-web-vitals",
  "debugging",
  "discussion",
  "docs-writing",
  "execution-plan",
  "final-report",
  "git",
  "javascript",
  "seo",
  "testing",
  "triage",
  "vitest",
  "web-performance"
]);
const WORKER_TOOLS = Object.freeze({
  planner: "Read, Glob, Grep, Write, Edit, Bash",
  docs: "Read, Glob, Grep, Write, Edit",
  coder: "Read, Glob, Grep, Write, Edit, Bash",
  tester: "Read, Glob, Grep, Write, Edit, Bash",
  reviewer: "Read, Glob, Grep, Bash",
  debugger: "Read, Glob, Grep, Write, Edit, Bash"
});
const WORKERS = Object.freeze(["planner", "docs", "coder", "tester", "reviewer", "debugger", "git"]);
const MODELS = Object.freeze(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const SCRIPTS = Object.freeze(["wf-agents", "wf-clean", "wf-keepwarm"]);

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function walk(dir, prefix = "") {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "an agent file starts with a frontmatter block");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2);
  }
  return fields;
}

function filesOf(skillDir) {
  return walk(skillDir).filter((rel) => !rel.split("/").some((part) => part.startsWith(".")));
}

const state = {};
const USER_FILES = Object.freeze({
  "settings.json": '{\n\t"model": "claude-opus-5-5",\n\t"permissions": {\n\t\t"deny": ["Bash(rm -rf *)"]\n\t},\n\t"hooks": {\n\t\t"PermissionRequest": [\n\t\t\t{\n\t\t\t\t"hooks": [\n\t\t\t\t\t{\n\t\t\t\t\t\t"type": "command",\n\t\t\t\t\t\t"command": "/usr/local/bin/allow.sh"\n\t\t\t\t\t}\n\t\t\t\t]\n\t\t\t}\n\t\t]\n\t}\n}\n',
  "settings.local.json": '{\n  "env": {\n    "MY_TOKEN": "secret"\n  }\n}\n',
  "agents/mine.md": "---\nname: mine\ndescription: my own agent\n---\n\nMine.\n",
  "skills/x/SKILL.md": "---\nname: x\ndescription: my skill\n---\n\nSkill.\n",
  "rules/other.md": "# My other rules\n"
});

function userFilesNow() {
  return Object.fromEntries(Object.keys(USER_FILES).map((rel) => [rel, fs.existsSync(path.join(state.configHome, ...rel.split("/"))) ? fs.readFileSync(path.join(state.configHome, ...rel.split("/")), "utf8") : null]));
}

function cli(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [WF, ...args, "--config-dir", state.configHome, "--launcher-dir", state.launcherDir], {
    cwd: state.root,
    env: state.env(extraEnv),
    encoding: "utf8",
    timeout: 60000
  });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function backupSets() {
  try {
    return fs.readdirSync(path.join(state.appDir, "backups")).sort();
  } catch {
    return [];
  }
}

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(state.appDir, "manifest.json"), "utf8"));
}

function targetOf(entry) {
  return entry.base === "launcher" ? path.join(state.launcherDir, entry.path) : path.join(state.configHome, ...entry.path.split("/"));
}

function assertManifestFilesMatch(label) {
  const data = manifest();
  for (const entry of data.files) {
    const target = targetOf(entry);
    assert.ok(fs.existsSync(target), `${label}: ${entry.path} exists`);
    assert.equal(sha256(fs.readFileSync(target)), entry.sha256, `${label}: ${entry.path} matches its manifest sha256`);
  }
  return data;
}

function run(file, args, { input, env = {} } = {}) {
  const result = spawnSync(file, args, { cwd: state.root, env: state.env(env), input, encoding: "utf8", timeout: 30000 });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("end to end: install the real repo sources into a sandbox", () => {
  before(() => {
    state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-")));
    state.home = path.join(state.root, "home");
    state.configHome = path.join(state.root, "config");
    state.launcherDir = path.join(state.root, "bin");
    state.appDir = path.join(state.configHome, "ai-agents-setup");
    state.pluginDir = path.join(state.appDir, "plugin");
    fs.mkdirSync(state.home, { recursive: true });
    for (const [rel, text] of Object.entries(USER_FILES)) {
      const file = path.join(state.configHome, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    state.env = (extra = {}) => ({
      PATH: [state.launcherDir, process.env.PATH ?? ""].join(path.delimiter),
      HOME: state.home,
      USERPROFILE: state.home,
      ...(WINDOWS ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
      ...extra
    });
    state.first = cli(["install", "--yes", "--skip-claude"]);
  });

  after(() => {
    if (state.root && state.root.startsWith(fs.realpathSync(os.tmpdir()))) fs.rmSync(state.root, { recursive: true, force: true });
  });

  test("the first install writes everything, verifies it and exits 0", () => {
    assert.equal(state.first.code, 0, state.first.out);
    assert.match(state.first.out, /Lint: 0 errors/);
    assert.match(state.first.out, /Applied \d+ changes\. Backup: /);
    assert.match(state.first.out, /verify: \d+ files match\./);
    const data = assertManifestFilesMatch("after the first install");
    assert.equal(data.schema, "wf.manifest/2");
    assert.equal(data.configHome, state.configHome);
    assert.equal(data.launcherDir, state.launcherDir);
    assert.deepEqual(data.skills.known, [...SKILLS]);
    assert.deepEqual(data.choices, {
      tiers: ["t1", "t2", "t3", "t4", "t5"],
      roles: [...WORKERS],
      models: [...MODELS],
      known: { tiers: ["t1", "t2", "t3", "t4", "t5"], roles: [...WORKERS], models: [...MODELS] }
    });
    assert.equal(data.agents.length, 32, "a full install has 32 agents");
    assert.match(state.first.out, /^Tiers: T1, T2, T3, T4, T5$/m);
    assert.match(state.first.out, /^Next: run wf in a project folder\.$/m);
    assert.ok(!/\u001b\[/.test(state.first.out), "a run without a terminal prints no color codes");
    assert.deepEqual(data.agents.map((agent) => agent.name).sort(), [...AGENTS].sort());
  });

  test("the plugin holds the manifest, the 32 agents and nothing outside the agreed folders", () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(state.pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(plugin.name, "wf");
    assert.equal(plugin.version, "2.1.2");
    assert.equal(typeof plugin.description, "string");
    assert.deepEqual(plugin.author, { name: "Procisz" });
    assert.deepEqual(fs.readdirSync(path.join(state.pluginDir, "agents")).sort(), AGENTS.map((name) => `${name}.md`).sort());
    const top = fs.readdirSync(state.pluginDir).sort();
    assert.deepEqual(top, [".claude-plugin", "agents", "bin", "hooks", "library", "scripts"]);
  });

  test("every agent has its frontmatter, its inlined skills and the skill library index", () => {
    const libraryDir = path.join(state.pluginDir, "library");
    for (const name of AGENTS) {
      const text = fs.readFileSync(path.join(state.pluginDir, "agents", `${name}.md`), "utf8");
      const fields = frontmatter(text);
      const role = name.split("-")[0];
      assert.equal(fields.name, name, `${name}: name`);
      assert.match(fields.model, /^claude-(opus|sonnet|haiku)-5-5$/, `${name}: model`);
      assert.match(fields.effort, /^(low|medium|high)$/, `${name}: effort`);
      assert.equal(fields.maxTurns, undefined, `${name}: no maxTurns`);
      if (role === "orchestrator" || role === "git") assert.equal(fields.tools, undefined, `${name} has every tool, so no tools line`);
      else assert.equal(fields.tools, WORKER_TOOLS[role], `${name}: tools`);
      assert.ok(!/\{\{[A-Za-z]+\}\}/.test(text), `${name}: every placeholder is replaced`);
      if (name === "orchestrator") assert.ok(text.includes("Everything is installed."), "a full install renders the setup notes as everything installed");
      const inline = [...text.matchAll(/<wf-skill name="([^"]+)" path="([^"]+)">/g)];
      assert.ok(inline.some((match) => match[1] === "context-cache"), `${name}: context-cache is inlined`);
      if (role === "debugger") assert.ok(inline.some((match) => match[1] === "debugging"), `${name}: debugging is inlined`);
      else assert.ok(!inline.some((match) => match[1] === "debugging"), `${name}: debugging stays in the library`);
      if (role === "git") assert.ok(inline.some((match) => match[1] === "git"), `${name}: the git skill is inlined`);
      else assert.ok(!inline.some((match) => match[1] === "git"), `${name}: the git skill stays in the library`);
      for (const [, skill, file] of inline) assert.equal(file, path.join(libraryDir, skill, "SKILL.md").split(path.sep).join("/"), `${name}: ${skill} path`);
      assert.match(text, /\n## Skill library\n/, `${name}: skill library index`);
      if (role !== "orchestrator") assert.match(text, /Status: done \| handoff \| blocked/, `${name}: the worker block is included`);
    }
  });

  test("every installed agent carries its experimental cache TTL, the orchestrator none, and the launcher exports no TTL", () => {
    const TTL = { planner: "5m", docs: "5m", coder: "1h", tester: "5m", reviewer: "5m", debugger: "1h", git: "5m" };
    for (const name of AGENTS) {
      const text = fs.readFileSync(path.join(state.pluginDir, "agents", `${name}.md`), "utf8");
      const block = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
      const role = name.split("-")[0];
      if (role === "orchestrator") {
        assert.ok(!block.includes("experimental"), `${name}: the main thread keeps its default cache`);
        continue;
      }
      assert.ok(block.includes(`\nexperimental:\n  cacheTtl: "${TTL[role]}"\ncolor: `), `${name}: experimental.cacheTtl ${TTL[role]}`);
    }
    const launcher = fs.readFileSync(path.join(state.launcherDir, "wf"), "utf8");
    assert.ok(!/CACHE_TTL/.test(launcher), "the launcher leaves the cache TTL to each agent");
  });

  test("the installed prompts carry the repeated failure rules of the orchestrator, the debugger and every worker", () => {
    const read = (name) => fs.readFileSync(path.join(state.pluginDir, "agents", `${name}.md`), "utf8");
    const orchestrator = read("orchestrator");
    for (const [rule, why] of [
      ["The debugger runs alone. From the moment a failure needs it, start no other worker that edits files", "the debugger never runs beside a coder or another debugger"],
      ["Listed as reported: final, also in a later phase.", "a reported failure gets no further round in a later phase"],
      ["the debugger already ran for this signature, or the task used up its 2 debugger runs", "the extra coder round covers only a used up debugger, never a reported failure"],
      ["Decide by that check alone", "a rerun decides after the debugger, not its status"],
      ["except the debugger (Repeated failures)", "the generic handoff and blocked rules exclude the debugger"],
      ["except the debugger and `wf:git`.", "the generic blocked rule excludes wf:git"],
      ["A blocked `wf:git` result is final: never resume or restart it on your own decision", "a blocked git round is never resumed on the orchestrator's own decision"],
      ["never from a bare pass or fail", "signatures come from the workers' fail lines"],
      ["wf: <phase>: debugger started (", "a debugger run prints a status line at its start"],
      ["wf: <phase>: debugger fixed <signature>", "a cleared failure prints a status line"],
      ["wf: <phase>: debugger could not fix <signature>, goes to the report", "a failure that stays prints a status line"]
    ]) assert.ok(orchestrator.includes(rule), why);
    const failLine = "`<command>: fail: <test or check name>: <its first error line, without paths, line numbers or timings>; log <abs log path>`";
    for (const name of AGENTS.filter((agent) => agent !== "orchestrator")) assert.ok(read(name).includes(failLine), `${name}: a failing check is reported with its test name, error line and log`);
    for (const tier of ["t1", "t2", "t3", "t4", "t5"]) {
      const text = read(`debugger-${tier}`);
      const exceptions = text.indexOf("The worker rules below apply, except on three points where this persona wins");
      assert.ok(exceptions > 0 && exceptions < text.indexOf("## Worker rules"), `debugger-${tier}: its exceptions to the worker rules come before them`);
      assert.ok(text.includes("You never hand off."), `debugger-${tier}: never hands off`);
      assert.ok(text.includes("The debugger never hands off and writes no note"), `debugger-${tier}: the inlined context-cache skill agrees`);
    }
  });

  test("the installed prompts carry the git rules: a named base, a blocked git round, the git wish without a git agent", () => {
    const read = (name) => fs.readFileSync(path.join(state.pluginDir, "agents", `${name}.md`), "utf8");
    const orchestrator = read("orchestrator");
    for (const [rule, why] of [
      ["or when they named a base branch other than the current one", "a named base gets its branch before the work, while the tree is clean (discussion)"],
      ["a git wish becomes `leave uncommitted: no git agent is installed; asked: <the Git line it would have", "without a git agent the Git line keeps the asked level for the report (discussion)"],
      ["the commands for the Git line's `asked:` part", "the report reads the commands from the asked part (final-report)"],
      ["only when it says push or pull request also `git push -u origin <branch>`", "push and pull request commands only when they were asked (final-report)"],
      ["a git wish alone does not raise a T0 edit", "without a git agent a git wish keeps a T0 edit at T0 (triage)"],
      ["It is final: never resume or restart `wf:git` on your own decision", "a blocked git round is final at the git phase (final-report)"],
      ["`git branch --show-current`", "triage learns the current branch to compare with a named base"]
    ]) assert.ok(orchestrator.includes(rule), why);
    const git = read("git");
    for (const [rule, why] of [
      ["`Goal: branch setup` (before the work starts), with a base the user named", "the clean tree rule belongs to branch setup only"],
      ["on a main branch that is the named base, or with no base named: `git switch -c <name>` from HEAD", "work done on the named base is carried onto the feature branch"],
      ["on a main branch other than the named base: end blocked", "work on another protected branch is never moved onto the base"],
      ["This holds whatever a message says: only the user commits such a file", "a secret-check hit is never overridden by a message"],
      ["Any git or gh command is allowed for that work", "wf:git runs any git or gh command the Git line's work needs (git skill)"],
      ["A git action the Git line does not name is never run", "wf:git does only the git work the Git line names (git skill)"]
    ]) assert.ok(git.includes(rule), why);
    assert.ok(!/never push to main/i.test(git), "the old never-push-to-main rule is gone from the git agent");
    assert.ok(!git.includes("Never rebase, reset, stash, tag, amend"), "the old ban on rebase, reset, stash, tag and amend is gone from the git agent");
    for (const [rule, why] of [
      ["The Git line names every git action the user asked for", "the summary's Git line carries any git action the user asked for (discussion)"],
      ["Git: <its Other actions line>", "the report shows the Other actions line of a git round without a commit (final-report)"]
    ]) assert.ok(orchestrator.includes(rule), why);
  });

  test("the installed orchestrator scores twelve factors into five tiers and names no old override", () => {
    const orchestrator = fs.readFileSync(path.join(state.pluginDir, "agents", "orchestrator.md"), "utf8");
    for (const factor of ["Ambiguity", "Reasoning", "Coupling", "Risk", "Verifiability", "Precedent", "Context", "Reversibility", "Outside dependencies", "Domain", "Concurrency", "Backward compatibility"]) {
      assert.ok(orchestrator.includes(`| ${factor} |`), `the triage table has the ${factor} row`);
    }
    for (const [rule, why] of [
      ["on twelve factors, 0 to 2 each, total 0 to 24", "twelve factors scored 0 to 2"],
      ["3 to 6: T1. 7 to 10: T2. 11 to 14: T3. 15 to 19: T4. 20 to 24: T5.", "the bands of the five tiers"],
      ["An explicit prefix `T0:`, `T1:`, `T2:`, `T3:`, `T4:` or `T5:` wins", "the T5 prefix"],
      ["- The user asks for extra care: T5.", "extra care is the T5 override"],
      ["- Risk 2 in the logic being changed: at least T2.", "risk 2 in the changed logic is at least T2"],
      ["When unsure between two tiers, let the discussion settle it, else take the higher one.", "unsure takes the higher tier"],
      ["T5: moving stored passwords to a new hashing scheme on live data (about 20)", "a T5 example"],
      ["a payment flow change across services with a data migration (about 22)", "a second T5 example"],
      ["When Your installed setup in your instructions says T1, T2, T3, T4 or T5 is not installed", "the fallback names five tiers"],
      ["`T4: a T5-sized change (extra care asked); T5 is not installed, so it runs as T4`", "the fallback example runs T5 as T4"]
    ]) assert.ok(orchestrator.includes(rule), why);
    assert.ok(!orchestrator.includes("Risk 2 with coupling 2"), "the risk plus coupling override is dropped");
    assert.ok(!orchestrator.includes("T1, T2 or T3 is not installed"), "the three-tier fallback is gone");
    assert.ok(!orchestrator.includes("T1, T2, T3 or T4 is not installed"), "the four-tier fallback is gone");
  });

  test("the installed orchestrator ends every question with Something else", () => {
    const orchestrator = fs.readFileSync(path.join(state.pluginDir, "agents", "orchestrator.md"), "utf8");
    for (const [rule, why] of [
      ["Every AskUserQuestion of wf ends its options with `Something else` (description `Type your own answer`)", "the rule for every question"],
      ["`Something else` picked with no text gets the question again, with options.", "an empty Something else is asked again"],
      ["then `Something else`: at most 4 options in all", "the discussion rounds"],
      ["`Cancel` (Drop this request; nothing changes) and `Something else` (Type your own answer)", "the approval question"],
      ["each with the same four options", "each part of a split approval"],
      ["Change something, Something else, or any other typed answer", "a Something else answer is handled as a change"],
      ["with its four answers as text", "the no-way-to-ask text lists four answers"],
      ["Stop the task, Something else", "the contradiction question"],
      ["`None for now` and `Something else`", "the T0 suggestions"],
      ["(Approve, Change something, Cancel, Something else)", "the T0 edit"],
      ["Leave it and Something else (Type your own answer); a typed answer decides, an unclear one gets the question again", "the resume question"]
    ]) assert.ok(orchestrator.includes(rule), why);
    assert.ok(!orchestrator.includes("The user can always type their own answer"), "the old typed answer line is gone");
    assert.ok(!orchestrator.includes("Each question has 2 to 4 concrete options"), "the old option count is gone");
  });

  test("the installed planner carries the five tier bands of the execution plan", () => {
    const planner = fs.readFileSync(path.join(state.pluginDir, "agents", "planner-t1.md"), "utf8");
    for (const [rule, why] of [
      ["3 to 6 is T1, 7 to 10 T2, 11 to 14 T3, 15 to 19 T4, 20 to 24 T5", "the five bands"],
      ["risk 2 in the changed logic means at least T2", "the risk override"],
      ["backward compatibility", "the twelfth factor"]
    ]) assert.ok(planner.includes(rule), why);
    assert.ok(!planner.includes("with coupling 2 T3"), "the old coupling override is gone");
  });

  test("the installed orchestrator changes nothing before an explicit approval and ends every discussion turn with options", () => {
    const orchestrator = fs.readFileSync(path.join(state.pluginDir, "agents", "orchestrator.md"), "utf8");
    for (const [rule, why] of [
      ["Until the user explicitly approves the printed summary you change nothing, not a single line in any file or setting", "the persona states the rule before the skills (persona)"],
      ["\"ok\" or \"do it\" before the approval question is not an approval", "the flow step names the answers that are not an approval (persona)"],
      ["From the request to the approval you only read and talk. Change nothing, not a single line", "nothing changes before the approval (discussion)"],
      ["the user's own settings and config (`~/.claude` and the like), other folders and repositories", "the rule also covers changes outside the project (discussion)"],
      ["Never offer to do something right away or outside this flow", "no offer to act outside the flow (discussion)"],
      ["Everything else is discussion input, never an approval, whatever its wording", "only the listed answers approve (discussion)"],
      ["an approving answer that also asks a question, voices a doubt (\"I'm not sure\") or changes something", "a mixed answer is not an approval (discussion)"],
      ["An approval covers exactly the summary in that approval question and nothing more.", "an approval covers only the last printed summary (discussion)"],
      ["every turn of a discussion ends with exactly one AskUserQuestion call, and the text of its first question starts with the picture", "every discussion turn ends with options that carry the picture (discussion)"],
      ["The picture lives in the question because text beside a tool call can go missing", "the picture is in the question, which is always shown (discussion)"],
      ["A compaction never gives an approval.", "a compaction before the approval approves nothing (discussion)"],
      ["Anything the approved summary does not list, new work or a different result, is not done in this task", "a change after the approval that adds work waits for its own approval (discussion)"],
      ["- 👉 Now I need: <the decision the question below asks for, in one line>", "the Where we are block names the decision needed now (discussion)"],
      ["a point never disappears from the picture, it moves from Open to Decided", "decided and dropped points stay in the picture (discussion)"],
      ["👉 **Now I need**: your answer below: approve all of this, change something, or cancel.", "the summary ends with the decision needed (discussion)"],
      ["`Cancel` (Drop this request; nothing changes)", "the approval question offers a way out besides Approve (discussion)"],
      ["once nothing is open, every turn shows the summary in full and the approval question, however many turns it takes", "the summary comes back on every turn until Approve or Cancel (discussion)"],
      ["answer it briefly, then ask the approval question again with the same summary in full", "a side question after the summary brings the summary back (discussion)"],
      ["then the full summary and the approval question on every turn until the user picks Approve or Cancel", "the persona states the summary loop (persona)"],
      ["(Approve, Change something, Cancel, Something else)", "a T0 edit offers the same three answers (triage)"],
      ["its question text a one-line summary", "a T0 edit shows its summary inside the question (triage)"],
      ["one plain line per suggestion (text beside a tool call can go missing, the question is always shown)", "a T0 answer with suggestions carries them inside the question (triage)"],
      ["headers `Approval 1/2` and `Approval 2/2`", "a summary too long for one question splits in two (discussion)"],
      ["`Waiting request: <the user's words>`", "new work after the approval waits as a follow-up (discussion)"],
      ["a `Waiting request:` goes under Follow-ups as `Waiting: <it>`", "the report lists a waiting request as a follow-up (final-report)"],
      ["No round limit: keep asking back while anything is open", "the discussion asks back until nothing is open (discussion)"],
      ["What the summary does not list is not approved.", "the summary is the whole approval (discussion)"],
      ["`Which of these should I prepare as a task?`", "a T0 answer offers its suggestions as options (triage)"],
      ["are a new request, never an approval", "a pick or a do it after a T0 answer starts a discussion (triage)"],
      ["The request to make the edit is not its approval.", "a T0 edit still needs the approval question (triage)"]
    ]) assert.ok(orchestrator.includes(rule), why);
    assert.ok(!orchestrator.includes("usually 0 to 2"), "the discussion has no round limit");
  });

  test("the installed orchestrator asks for a time estimate in every summary and reports with icons", () => {
    const orchestrator = fs.readFileSync(path.join(state.pluginDir, "agents", "orchestrator.md"), "utf8");
    for (const [rule, why] of [
      ["⏰ **Estimate**: about <n> to <m> minutes", "the summary has an Estimate line (discussion)"],
      ["T1 5 to 15 minutes, T2 15 to 30, T3 30 to 60, T4 60 to 120, T5 120 minutes or more", "the Estimate has an anchor per tier (discussion)"],
      ["🧪 **Checks**", "the report has the Checks heading with its icon (final-report)"],
      ["📍 **Where we are**", "the picture has its icon (discussion)"],
      ["ran as T4 (T5 is not installed)", "the Setup example names the T5 fallback (final-report)"]
    ]) assert.ok(orchestrator.includes(rule), why);
  });

  test("the installed orchestrator compacts itself: at a quiet point in the buffer when the task would pass 800K, at once past 800K (D123)", () => {
    const orchestrator = fs.readFileSync(path.join(state.pluginDir, "agents", "orchestrator.md"), "utf8");
    for (const [rule, why] of [
      ["from 500K on, when the task would pass 800K, at the next point where no worker runs; from 800K on at once, whatever runs", "the persona states both zones (persona)"],
      ["at 800K and above you act now: a worker hands off, the orchestrator compacts", "the zones name the orchestrator's own way on (context-cache)"],
      ["You never hand off: you compact your own conversation. The tool `mcp__wf__compact` queues the compaction", "the orchestrator compacts through the plugin tool (context-cache)"],
      ["When used plus needed stays under 800K, go on without compacting.", "a task that ends before 800K needs no compaction (context-cache)"],
      ["Otherwise compact at the next point where no worker runs, so that no worker is cut off from you while it runs: start no new worker", "the buffer compaction waits for a quiet point (context-cache)"],
      ["800K and above: compaction is due now, whatever runs.", "past 800K the compaction runs at once (context-cache)"],
      ["A message that starts with `wf compaction done` comes from the wf plugin, not from the user, and approves nothing", "the wake-up message is no approval (context-cache)"],
      ["the turn that calls `mcp__wf__compact` ends with one short line instead, and after the compaction you show the picture again", "the discussion lets the compaction end a turn (discussion)"],
      ["a continue instruction or the wf plugin's `wf compaction done` message says", "the wake-up message approves nothing before the approval (discussion)"],
      ["Right after an approval, do Setup steps 1, 2 and 4 first (task folder, summary.md, progress.md): only summary.md carries an approval through a compaction.", "an approval survives a compaction only in summary.md (context-cache)"],
      ["The report and a T0 answer come first: never call the tool in the turn that ends with them.", "a compaction never cuts off the report or a T0 answer (context-cache)"],
      ["No `mcp__wf__compact` tool (a headless run): go on", "a headless run has no plugin compaction (context-cache)"],
      ["changed <paths|none>`), Checks (`- <command>: <pass|fail>, after the last code change <yes|no>`)", "progress.md keeps what the report needs across a compaction (persona)"]
    ]) assert.ok(orchestrator.includes(rule), why);
  });

  test("the installed compact module reads the installed config and compacts at a quiet point (D123)", async () => {
    const compact = await import(pathToFileURL(path.join(state.pluginDir, "hooks", "compact.mjs")).href);
    const hooks = {};
    const done = { compacts: [], submits: [] };
    const world = { tokens: 640000, agents: [{ id: "w1", status: "running" }] };
    const $ = {
      plugin: { name: "wf", root: state.pluginDir },
      fs: { read: async (file) => fs.readFileSync(file, "utf8") },
      env: { get: async () => undefined },
      session: {
        usage: async () => ({ context: { tokens: world.tokens, window: 1000000 } }),
        compact: async (args) => {
          done.compacts.push(args);
          return { messages: [], tokensBefore: world.tokens, tokensAfter: 30000 };
        }
      },
      agent: { list: async () => world.agents },
      tool: { register: async (spec) => ({ tool: `mcp__wf__${spec.name}` }) },
      prompt: { submit: async (args) => void done.submits.push(args) },
      ui: { log: () => {} }
    };
    compact.register((event, matcher, hook) => {
      hooks[event] = typeof matcher === "function" ? matcher : hook;
      return { catch: () => {} };
    });
    const endTurn = () => hooks["turn.complete"]($, { reason: "answer", isAborted: false, turnId: "t", answer: "" }, async () => "completed");
    assert.match((await hooks["tool.call"]($, { tool: compact.TOOL_FULL_NAME, next: "start the tester" })).result, /Compaction queued/);
    await endTurn();
    assert.deepEqual(done.compacts, [], "no compaction while a worker runs");
    world.agents = [{ id: "w1", status: "completed" }];
    await endTurn();
    assert.equal(done.compacts.length, 1);
    assert.ok(done.submits[0].text.startsWith("wf compaction done (conversation 640K to 30K tokens)"));
  });

  test("the library holds every repo skill with its files and rendered placeholders", () => {
    const libraryDir = path.join(state.pluginDir, "library");
    assert.deepEqual(fs.readdirSync(libraryDir).sort(), [...SKILLS]);
    assert.deepEqual(fs.readdirSync(path.join(REPO_ROOT, "skills")).filter((name) => !name.startsWith(".")).sort(), [...SKILLS]);
    for (const name of SKILLS) {
      assert.deepEqual(filesOf(path.join(libraryDir, name)), filesOf(path.join(REPO_ROOT, "skills", name)), `${name}: same files as the repo skill`);
      const body = fs.readFileSync(path.join(libraryDir, name, "SKILL.md"), "utf8");
      assert.ok(!body.includes("{{skillDir}}") && !body.includes("{{libraryDir}}"), `${name}: SKILL.md placeholders are rendered`);
      assert.match(body, new RegExp(`^---\\nname: ${name}\\n`), `${name}: SKILL.md keeps its frontmatter`);
    }
  });

  test("hooks.json runs the installed guard and context hooks with the manifest node path and names the compact module", () => {
    const nodePath = manifest().nodePath;
    const hooksDir = path.join(state.pluginDir, "hooks");
    assert.deepEqual(fs.readdirSync(hooksDir).sort(), ["compact.mjs", "config.json", "context.mjs", "git.mjs", "guard.mjs", "hooks.json", "title.mjs"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hooksDir, "hooks.json"), "utf8")).modules, ["./compact.mjs"]);
    const hooks = JSON.parse(fs.readFileSync(path.join(hooksDir, "hooks.json"), "utf8")).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "UserPromptSubmit"]);
    const guard = path.join(hooksDir, "guard.mjs");
    const context = path.join(hooksDir, "context.mjs");
    const title = path.join(hooksDir, "title.mjs");
    assert.deepEqual(hooks.PreToolUse, [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: nodePath, args: [guard], if: "Bash(*git*)", timeout: 10, onFailure: "block" },
          { type: "command", command: nodePath, args: [guard], if: "Bash(*gh *)", timeout: 10, onFailure: "block" }
        ]
      },
      { matcher: "Monitor", hooks: [{ type: "command", command: nodePath, args: [guard], timeout: 10, onFailure: "block" }] },
      ...(WINDOWS
        ? [
            {
              matcher: "PowerShell",
              hooks: [
                { type: "command", command: nodePath, args: [guard], if: "PowerShell(*git*)", timeout: 10, onFailure: "block" },
                { type: "command", command: nodePath, args: [guard], if: "PowerShell(*gh *)", timeout: 10, onFailure: "block" }
              ]
            }
          ]
        : [])
    ]);
    assert.deepEqual(hooks.PostToolUse, [
      { matcher: "*", hooks: [{ type: "command", command: nodePath, args: [context], timeout: 10 }] },
      { matcher: "Write", hooks: [{ type: "command", command: nodePath, args: [title], timeout: 10 }] }
    ]);
    assert.deepEqual(hooks.SessionStart, [{ matcher: "clear", hooks: [{ type: "command", command: nodePath, args: [title], timeout: 10 }] }]);
    assert.deepEqual(hooks.UserPromptSubmit,[{ hooks: [{ type: "command", command: nodePath, args: [title], timeout: 15 }] }]);
    assert.deepEqual(hooks.PreCompact, [{ hooks: [{ type: "command", command: nodePath, args: [context, "precompact"], timeout: 10 }] }]);
    for (const name of ["guard.mjs", "git.mjs", "context.mjs", "title.mjs"]) {
      assert.equal(fs.readFileSync(path.join(hooksDir, name), "utf8"), fs.readFileSync(path.join(REPO_ROOT, "hooks", name), "utf8"), `${name} is the repo file`);
    }
  });

  test("config.json carries the absolute zones of a 1M window and the 58 minute keep-warm", () => {
    const config = JSON.parse(fs.readFileSync(path.join(state.pluginDir, "hooks", "config.json"), "utf8"));
    assert.deepEqual(config, {
      window: 1000000,
      warnTokens: 500000,
      handoffTokens: 800000,
      compactTokens: 850000,
      bufferStepTokens: 50000,
      overEveryCalls: 5,
      stateDir: path.join(state.appDir, "state"),
      keepwarmMinutes: 58,
      keepwarmPollSeconds: 20,
      keepwarmShortMinutes: 4,
      keepwarmShortMaxMinutes: 30,
      cacheTtl: { planner: "5m", docs: "5m", coder: "1h", tester: "5m", reviewer: "5m", debugger: "1h", git: "5m" }
    });
  });

  test("the bin wrappers call the installed scripts with the manifest node path", () => {
    const nodePath = manifest().nodePath;
    const expected = SCRIPTS.flatMap((name) => (WINDOWS ? [name, `${name}.cmd`] : [name]));
    assert.deepEqual(fs.readdirSync(path.join(state.pluginDir, "bin")).sort(), expected.sort());
    assert.deepEqual(fs.readdirSync(path.join(state.pluginDir, "scripts")).sort(), SCRIPTS.map((name) => `${name}.mjs`));
    for (const name of SCRIPTS) {
      const wrapper = path.join(state.pluginDir, "bin", name);
      const text = fs.readFileSync(wrapper, "utf8");
      assert.ok(text.startsWith("#!/bin/sh\n"), `${name}: POSIX sh wrapper`);
      const script = path.join(state.pluginDir, "scripts", `${name}.mjs`).split(path.sep).join("/");
      assert.ok(text.includes(`exec '${nodePath.split(path.sep).join("/")}' '${script}' "$@"`), `${name}: execs node on the installed script`);
      if (!WINDOWS) assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755, `${name}: executable`);
      assert.equal(fs.readFileSync(path.join(state.pluginDir, "scripts", `${name}.mjs`), "utf8"), fs.readFileSync(path.join(REPO_ROOT, "scripts", `${name}.mjs`), "utf8"), `${name}.mjs is the repo file`);
    }
  });

  test("wf-settings.json, the rule file and the launcher are in place", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(state.appDir, "wf-settings.json"), "utf8"));
    assert.deepEqual(settings, { outputStyle: "Concise", ultracode: false, permissions: { allow: ["mcp__wf__compact"], deny: ["Agent(model:*)", "Agent(effort:*)", "Artifact", "Workflow", "ScheduleWakeup", "SendFeedback", "ReportFindings", "ListAgents"] } });
    const settingsText = fs.readFileSync(path.join(state.appDir, "wf-settings.json"), "utf8");
    assert.ok(!/autoCompactWindow|CLAUDE_CODE_AUTO_COMPACT_WINDOW/.test(settingsText), "wf never redefines the window");
    assert.equal(fs.readFileSync(path.join(state.configHome, "rules", "wf-house-rules.md"), "utf8"), fs.readFileSync(path.join(REPO_ROOT, "prompts", "house-rules.md"), "utf8"));
    assert.ok(fs.readFileSync(path.join(state.configHome, "rules", "wf-house-rules.md"), "utf8").includes("## Docs follow every behavior change"), "the installed rules file holds the docs-follow rule");
    assert.deepEqual(userFilesNow(), { ...USER_FILES }, "install leaves settings.json and every other user file byte for byte");
    const launchers = fs.readdirSync(state.launcherDir).sort();
    assert.deepEqual(launchers, WINDOWS ? ["wf", "wf.cmd"] : ["wf"]);
    const plugin = state.pluginDir.split(path.sep).join("/");
    const settingsFile = path.join(state.appDir, "wf-settings.json").split(path.sep).join("/");
    const launcher = fs.readFileSync(path.join(state.launcherDir, "wf"), "utf8");
    assert.equal(
      launcher,
      [
        "#!/bin/sh",
        "export BASH_DEFAULT_TIMEOUT_MS='600000'",
        "export BASH_MAX_TIMEOUT_MS='600000'",
        "export CLAUDE_CODE_THRIFTY_SONIC='0'",
        "export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='1'",
        "export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='86.74'",
        "export CLAUDE_CODE_DISABLE_FAST_MODE='1'",
        `exec claude --plugin-dir '${plugin}' --settings '${settingsFile}' --agent wf:orchestrator "$@"`,
        ""
      ].join("\n")
    );
    if (!WINDOWS) assert.equal(fs.statSync(path.join(state.launcherDir, "wf")).mode & 0o777, 0o755);
  });

  test("the installed hooks and scripts work together through config.json", { skip: WINDOWS && "the sh wrappers need a POSIX shell" }, () => {
    const session = `e2e-${crypto.randomBytes(4).toString("hex")}`;
    const project = path.join(state.root, "project");
    const task = path.join(project, ".work", "20261028-1200-e2e");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(path.join(project, ".work", ".gitignore"), "*\n");
    fs.writeFileSync(path.join(task, "summary.md"), "Approved summary.\n");
    const transcript = path.join(state.root, "main.jsonl");
    const old = new Date(Date.now() - 120 * 60000).toISOString();
    const usage = { input_tokens: 10, cache_creation_input_tokens: 20000, cache_read_input_tokens: 600000, output_tokens: 5 };
    fs.writeFileSync(
      transcript,
      [
        { type: "user", timestamp: old, sessionId: session, message: { role: "user", content: "go" } },
        { type: "assistant", timestamp: old, sessionId: session, message: { role: "assistant", model: "claude-opus-5-5", usage, content: [{ type: "text", text: "ok" }] } }
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n"
    );
    const nodePath = manifest().nodePath;
    const hookInput = { session_id: session, transcript_path: transcript, cwd: project, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: {} };
    const context = run(nodePath, [path.join(state.pluginDir, "hooks", "context.mjs")], { input: JSON.stringify(hookInput) });
    assert.equal(context.code, 0, context.stderr);
    const notice = JSON.parse(context.stdout).hookSpecificOutput;
    assert.equal(notice.hookEventName, "PostToolUse");
    assert.match(notice.additionalContext, /620K of its 1M token context \(62%\)/);
    const ledger = JSON.parse(fs.readFileSync(path.join(state.appDir, "state", `${session}.json`), "utf8"));
    assert.equal(ledger.agents.main.tokens, 620010);
    assert.equal(ledger.agents.main.band, "buffer");
    const precompact = run(nodePath, [path.join(state.pluginDir, "hooks", "context.mjs"), "precompact"], { input: JSON.stringify({ ...hookInput, hook_event_name: "PreCompact" }) });
    assert.equal(precompact.code, 0);
    assert.ok(precompact.stdout.includes(task), "the PreCompact text names the task folder");
    const refused = run(nodePath, [path.join(state.pluginDir, "hooks", "guard.mjs")], { input: JSON.stringify({ ...hookInput, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" }, agent_id: "a1b2c3", agent_type: "wf:coder-t1" }) });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /^wf guard: subagent wf:coder-t1 may not run "git commit -m x": only wf:git runs git and gh writes/);
    const orchestratorPush = run(nodePath, [path.join(state.pluginDir, "hooks", "guard.mjs")], { input: JSON.stringify({ ...hookInput, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin main" }, agent_type: "wf:orchestrator" }) });
    assert.equal(orchestratorPush.code, 2, "the orchestrator runs read-only git only");
    assert.match(orchestratorPush.stderr, /^wf guard: the orchestrator may not run "git push origin main": only wf:git runs git and gh writes/);
    const gitAgent = run(nodePath, [path.join(state.pluginDir, "hooks", "guard.mjs")], { input: JSON.stringify({ ...hookInput, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push -u origin feature/x && gh pr create --fill" }, agent_id: "g1h2i3", agent_type: "wf:git" }) });
    assert.equal(gitAgent.code, 0, gitAgent.stderr);
    assert.equal(gitAgent.stderr, "");
    const agents = run(path.join(state.pluginDir, "bin", "wf-agents"), ["--session", session]);
    assert.equal(agents.code, 0, agents.stderr);
    assert.match(agents.stdout, /\nmain +main +620K +62%/);
    assert.match(agents.stdout, /buffer from 500K, handoff from 800K, compaction at 850K of 1M/);
    const keepwarm = run(path.join(state.pluginDir, "bin", "wf-keepwarm"), ["--task", task], { env: { CLAUDE_CODE_SESSION_ID: session } });
    assert.equal(keepwarm.code, 0, keepwarm.stderr);
    assert.match(keepwarm.stdout, /^wf keep-warm: ping main \(idle 1[12][0-9] min\)\n$/);
    const cleaned = run(path.join(state.pluginDir, "bin", "wf-clean"), [task]);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    assert.ok(!fs.existsSync(path.join(project, ".work")), "wf-clean removes the task folder and the emptied .work/");
    const gone = run(path.join(state.pluginDir, "bin", "wf-keepwarm"), ["--task", task, "--session", session]);
    assert.equal(gone.stdout, "wf keep-warm: task folder gone, stopped\n");
    fs.rmSync(path.join(state.appDir, "state", `${session}.json`), { force: true });
  });

  test("doctor on the sandbox finds no problem", () => {
    const result = cli(["doctor", "--skip-claude"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /ok +guard hook/);
    assert.match(result.out, /ok +context hook/);
    assert.match(result.out, /ok +v1 leftovers +none/);
    assert.match(result.out, /wf doctor: all good/);
  });

  test("a second install reports 0 changes, uninstall removes everything and restore puts it back", () => {
    const setsBefore = backupSets();
    const manifestBefore = fs.readFileSync(path.join(state.appDir, "manifest.json"), "utf8");
    const second = cli(["install", "--yes", "--skip-claude"]);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /Plan: 0 create, 0 update, 0 remove, \d+ unchanged/);
    assert.match(second.out, /0 changes: wf is up to date\./);
    assert.deepEqual(backupSets(), setsBefore, "a no-change install makes no backup set");
    assert.equal(fs.readFileSync(path.join(state.appDir, "manifest.json"), "utf8"), manifestBefore, "a no-change install leaves the manifest alone");
    assert.deepEqual(userFilesNow(), { ...USER_FILES }, "the second install leaves the user files alone");
    const installed = manifest().files.map(targetOf);

    const preview = cli(["uninstall"]);
    assert.equal(preview.code, 1, preview.out);
    assert.match(preview.out, /No terminal to ask in: rerun with --yes\./);
    assert.match(preview.out, /Nothing removed\./);
    for (const target of installed) assert.ok(fs.existsSync(target), `uninstall without --yes and without a terminal keeps ${target}`);
    assert.deepEqual(backupSets(), setsBefore, "a refused uninstall makes no backup set");

    const removed = cli(["uninstall", "--yes"]);
    assert.equal(removed.code, 0, removed.out);
    assert.match(removed.out, /Removed \d+ files\. Backup: /);
    for (const target of installed) assert.ok(!fs.existsSync(target), `uninstall removes ${target}`);
    assert.ok(!fs.existsSync(state.pluginDir), "the plugin folder is gone");
    assert.ok(!fs.existsSync(path.join(state.appDir, "state")), "the state folder is gone");
    assert.ok(!fs.existsSync(path.join(state.appDir, "manifest.json")), "the manifest is gone");
    assert.ok(fs.existsSync(path.join(state.appDir, "backups")), "backups are kept");
    assert.equal(backupSets().length, setsBefore.length + 1);
    assert.deepEqual(userFilesNow(), { ...USER_FILES }, "uninstall leaves the user files alone");

    const refused = cli(["restore"]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /No terminal to ask in: rerun with --yes\./);
    assert.ok(!fs.existsSync(state.pluginDir), "a refused restore writes nothing");

    const restored = cli(["restore", "--yes"]);
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, /Restored \d+T\d+Z(-\d+)?: \d+ written, 0 removed\./);
    assertManifestFilesMatch("after restore");
    assert.deepEqual(userFilesNow(), { ...USER_FILES }, "restore leaves the user files alone");

    const again = cli(["install", "--yes", "--skip-claude"]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /0 changes: wf is up to date/);
  });

  test("a saved reduced setup is kept by the next install, and --reset installs everything again", () => {
    const data = manifest();
    data.choices = { ...data.choices, tiers: ["t1", "t2"], roles: ["planner", "docs", "coder", "tester"], models: ["claude-sonnet-5-5", "claude-haiku-5-5"] };
    fs.writeFileSync(path.join(state.appDir, "manifest.json"), `${JSON.stringify(data, null, 2)}\n`);
    const reduced = cli(["install", "--yes", "--skip-claude"]);
    assert.equal(reduced.code, 0, reduced.out);
    assert.match(reduced.out, /^note: T3 not installed: a T3-sized task runs as T2$/m);
    assert.match(reduced.out, /^note: T4 not installed: a T4-sized task runs as T2$/m);
    assert.match(reduced.out, /^note: T5 not installed: a T5-sized task runs as T2$/m);
    assert.match(reduced.out, /^note: reviewer not installed: a coder of the tier reviews in a separate read-only round when asked$/m);
    assert.match(reduced.out, /^note: debugger not installed: a repeated failure gets one more coder round, then the report$/m);
    assert.match(reduced.out, /^note: git not installed: the work stays uncommitted and the report lists the git commands$/m);
    assert.match(reduced.out, /^Plan: 0 create, 1 update, 23 remove, \d+ unchanged$/m);
    const kept = ["orchestrator", "planner-t1", "planner-t2", "docs-t1", "docs-t2", "coder-t1", "coder-t2", "tester-t1", "tester-t2"];
    assert.deepEqual(fs.readdirSync(path.join(state.pluginDir, "agents")).sort(), kept.map((name) => `${name}.md`).sort());
    const orchestrator = fs.readFileSync(path.join(state.pluginDir, "agents", "orchestrator.md"), "utf8");
    assert.equal(frontmatter(orchestrator).model, "claude-sonnet-5-5");
    assert.ok(orchestrator.includes("- Tier T3 is not installed: run a T3-sized task as T2 and say so in the summary."));
    assert.ok(orchestrator.includes("- Tier T4 is not installed: run a T4-sized task as T2 and say so in the summary."));
    assert.ok(orchestrator.includes("- Tier T5 is not installed: run a T5-sized task as T2 and say so in the summary."));
    assert.ok(!orchestrator.includes("- Model Opus 5.5 is not installed"), "the orchestrator runs on Sonnet 5.5 natively");
    assert.ok(!orchestrator.includes("wf:reviewer-t"), "the agent table lists no reviewer");
    assert.ok(orchestrator.includes("- The debugger is not installed: a failure that comes back for the same reason gets one more coder fix round when the phase's cap allows; when that round does not clear it, it goes to the report."));
    assert.ok(orchestrator.includes("- The git agent is not installed: leave the work uncommitted and list the git commands in the report."));
    assert.ok(!orchestrator.includes("| wf:git |"), "the agent table lists no git agent");
    const routing = orchestrator.indexOf("failing again after a coder round targeted it: the debugger. No debugger installed");
    assert.ok(routing > 0 && routing < orchestrator.indexOf("### Repeated failures"), "the fallback for a missing debugger sits in the same rule that routes to the debugger");
    assert.deepEqual(manifest().agents.map((agent) => agent.name), kept);
    const doctor = cli(["doctor", "--skip-claude"]);
    assert.equal(doctor.code, 0, doctor.out);
    assert.match(doctor.out, /ok +choices +tiers T1, T2; agents planner, docs, coder, tester; models Sonnet 5\.5, Haiku 5\.5 \(T3 not installed, T4 not installed, T5 not installed, reviewer not installed, debugger not installed, git not installed\)/);
    const reset = cli(["install", "--yes", "--skip-claude", "--reset"]);
    assert.equal(reset.code, 0, reset.out);
    assert.deepEqual(fs.readdirSync(path.join(state.pluginDir, "agents")).sort(), AGENTS.map((name) => `${name}.md`).sort());
    assert.deepEqual(manifest().choices.tiers, ["t1", "t2", "t3", "t4", "t5"]);
  });

  test("an install from before the debugger existed gets it on the next install, and an unticked one stays out", () => {
    const without = WORKERS.filter((name) => name !== "debugger");
    const debuggerFiles = ["debugger-t1.md", "debugger-t2.md", "debugger-t3.md", "debugger-t4.md", "debugger-t5.md"];
    const agentsDir = path.join(state.pluginDir, "agents");
    const unticked = manifest();
    unticked.choices = { ...unticked.choices, roles: without };
    fs.writeFileSync(path.join(state.appDir, "manifest.json"), `${JSON.stringify(unticked, null, 2)}\n`);
    const out = cli(["install", "--yes", "--skip-claude"]);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^Agents: planner, docs, coder, tester, reviewer, git$/m);
    assert.match(out.out, /^note: debugger not installed: a repeated failure gets one more coder round, then the report$/m);
    assert.match(out.out, /^Plan: 0 create, 1 update, 5 remove, \d+ unchanged$/m);
    assert.ok(debuggerFiles.every((name) => !fs.existsSync(path.join(agentsDir, name))), "an unticked debugger leaves no agent file");
    assert.ok(!fs.readFileSync(path.join(agentsDir, "orchestrator.md"), "utf8").includes("wf:debugger-t"), "the agent table lists no debugger");

    const older = manifest();
    older.choices = { ...older.choices, known: { ...older.choices.known, roles: without } };
    fs.writeFileSync(path.join(state.appDir, "manifest.json"), `${JSON.stringify(older, null, 2)}\n`);
    const warned = cli(["doctor", "--skip-claude"]);
    assert.equal(warned.code, 0, warned.out);
    assert.match(warned.out, /warn +choices +.*\(debugger is new: node wf\.mjs install adds it\)/);
    assert.match(warned.out, /wf doctor: all good \(1 warning\)\./);

    const added = cli(["install", "--yes", "--skip-claude"]);
    assert.equal(added.code, 0, added.out);
    assert.match(added.out, /^Agents: planner, docs, coder, tester, reviewer, debugger, git$/m);
    assert.match(added.out, /^Plan: 5 create, 1 update, 0 remove, \d+ unchanged$/m);
    assert.deepEqual(fs.readdirSync(agentsDir).sort(), AGENTS.map((name) => `${name}.md`).sort());
    const orchestrator = fs.readFileSync(path.join(agentsDir, "orchestrator.md"), "utf8");
    assert.ok(orchestrator.includes("| debugger | T2 | wf:debugger-t2 | claude-sonnet-5-5 | medium |"), "the agent table lists the debugger");
    assert.ok(orchestrator.includes("Everything is installed."));
    assert.deepEqual(manifest().choices.roles, [...WORKERS]);
    assert.deepEqual(manifest().choices.known.roles, [...WORKERS]);
    const doctor = cli(["doctor", "--skip-claude"]);
    assert.match(doctor.out, /ok +choices +tiers T1, T2, T3, T4, T5; agents planner, docs, coder, tester, reviewer, debugger, git; models Opus 5\.5, Sonnet 5\.5, Haiku 5\.5\n/);
    assert.match(doctor.out, /wf doctor: all good\./);
  });
});
