import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createGuard, listBackups, readManifest, writeManifest } from "../lib/core.mjs";
import { PassThrough } from "node:stream";
import { INSTALL_ABOUT, checkLocalNode, fitLine, helpText, lineMultiSelect, lineSelect, main, nodePathNotes, parseCommandLine, savedSelection, savedSetup, terminalIo, versionManagedNode } from "../lib/main.mjs";
import { createUi, stripAnsi, visibleLength } from "../lib/ui.mjs";
import { FAKE_CLAUDE, REPO_ROOT, captureIo, cleanup, fakeBuild, makePaths, scriptedSelections, tmpRoot } from "./data/install/helpers.mjs";

const SKILLS = [
  { name: "context-cache", description: "context", required: ["orchestrator", "planner", "docs", "coder", "tester", "reviewer", "debugger", "git"], defaults: [] },
  { name: "seo", description: "seo", required: [], defaults: ["reviewer"] }
];
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "test", "data", "compile", "registry.json"), "utf8"));
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const WORKERS = ["planner", "docs", "coder", "tester", "reviewer", "debugger", "git"];
const ALL = { tiers: ["t1", "t2", "t3"], roles: WORKERS, models: [OPUS, SONNET, HAIKU] };
const REDUCED = { tiers: ["t1", "t2"], roles: ["planner", "docs", "coder", "tester"], models: [SONNET, HAIKU] };
const KNOWN = { tiers: ALL.tiers, roles: WORKERS, models: ALL.models };
const RICH = createUi({ rich: true, unicode: true, color: true, columns: 100 });
const ANSI = /\u001b\[/;

function setup(t, { registry = REGISTRY } = {}) {
  const root = tmpRoot();
  t.after(() => cleanup(root));
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "registry.json"), JSON.stringify(registry));
  const paths = makePaths(root);
  const calls = { compile: [], lintSelf: 0 };
  const findings = [];
  const selfFindings = [];
  const modules = {
    loadSources: (repo) => ({ repoRoot: repo, registry, skills: SKILLS }),
    lintSources: () => findings,
    lintSelf: () => {
      calls.lintSelf += 1;
      return selfFindings;
    },
    compile: (sources, options) => {
      calls.compile.push(options);
      return fakeBuild(options.paths, calls.body ? { agentBody: calls.body } : {});
    }
  };
  const flags = ["--config-dir", paths.configHome, "--launcher-dir", paths.launcherDir];
  const go = async (argv, extra = {}) => {
    const io = extra.io ?? captureIo();
    const code = await main(argv, {
      io,
      env: { PATH: paths.launcherDir, HOME: path.join(root, "home"), ...(extra.env ?? {}) },
      repoRoot,
      modules,
      interactive: extra.interactive ?? false,
      ...(extra.ui ? { ui: extra.ui } : {}),
      now: () => new Date(extra.now ?? "2026-10-28T12:00:00Z")
    });
    return { code, io };
  };
  const saveChoices = (choices) => {
    const manifest = readManifest(paths).data;
    writeManifest(paths, { ...manifest, choices: { ...choices, known: KNOWN } }, createGuard(paths));
  };
  return { root, paths, repoRoot, modules, calls, findings, selfFindings, flags, go, saveChoices };
}

function choicesOf(options) {
  return options.choices;
}

describe("parseCommandLine", () => {
  test("commands and flags", () => {
    assert.deepEqual(parseCommandLine(["install", "--yes", "--dry-run", "--skills-reset", "--skip-claude"]).flags, { yes: true, dryRun: true, skillsReset: true, skipClaude: true });
    assert.deepEqual(parseCommandLine(["install", "--reset", "--json"]).flags, { reset: true, json: true });
    assert.equal(parseCommandLine(["diff", "--reset"]).flags.reset, true);
    assert.equal(parseCommandLine(["restore", "--to", "20261028T120000Z-2"]).flags.to, "20261028T120000Z-2");
    assert.equal(parseCommandLine(["lint", "--self"]).flags.self, true);
    assert.equal(parseCommandLine(["--help"]).command, "help");
    assert.equal(parseCommandLine(["help"]).command, "help");
    assert.equal(parseCommandLine([]).command, null);
  });

  const usage = [
    ["unknown command", ["bogus"]],
    ["unknown option", ["install", "--force"]],
    ["option of another command", ["install", "--to", "20261028T120000Z"]],
    ["self outside lint", ["doctor", "--self"]],
    ["json outside install", ["diff", "--json"]],
    ["reset outside install and diff", ["doctor", "--reset"]],
    ["bad stamp", ["restore", "--to", "yesterday"]],
    ["extra argument", ["diff", "now"]],
    ["missing option value", ["restore", "--to"]]
  ];
  for (const [name, argv] of usage) {
    test(`usage error: ${name}`, () => assert.throws(() => parseCommandLine(argv), (error) => error.exitCode === 2));
  }

  test("help lists every command and the new install flags", () => {
    for (const name of ["install", "uninstall", "restore", "diff", "doctor", "lint"]) assert.match(helpText(), new RegExp(`\\n  ${name} `));
    for (const flag of ["--reset", "--skills-reset", "--json"]) assert.ok(helpText().includes(flag), flag);
  });
});

describe("main", () => {
  test("help exits 0, no command exits 2, usage errors exit 2", async (t) => {
    const { go } = setup(t);
    assert.equal((await go(["--help"])).code, 0);
    const none = await go([]);
    assert.equal(none.code, 2);
    assert.match(none.io.text(), /usage: node wf\.mjs/);
    const bad = await go(["install", "--nope"]);
    assert.equal(bad.code, 2);
    assert.match(bad.io.text(), /Run node wf\.mjs --help/);
    assert.equal((await go(["doctor", "--config-dir", "relative/dir"])).code, 2);
  });

  test("install --yes --skip-claude writes the build and saves the choices and the skills answer", async (t) => {
    const { go, flags, paths, calls } = setup(t);
    const result = await go(["install", "--yes", "--skip-claude", ...flags]);
    assert.equal(result.code, 0, result.io.text());
    assert.deepEqual(choicesOf(calls.compile[0]), ALL);
    assert.deepEqual(calls.compile[0].selection.reviewer, ["context-cache", "seo"]);
    assert.equal(calls.compile[0].paths.configHome, paths.configHome);
    assert.equal(typeof calls.compile[0].nodePath, "string");
    assert.equal(fs.existsSync(path.join(paths.pluginDir, "agents", "coder-t1.md")), true);
    const manifest = readManifest(paths).data;
    assert.deepEqual(manifest.choices, { ...ALL, known: KNOWN });
    assert.deepEqual(manifest.skills.known, ["context-cache", "seo"]);
    assert.deepEqual(manifest.skills.selection.reviewer, ["context-cache", "seo"]);
    const text = result.io.text();
    for (const line of ["Lint: 0 errors, 0 warnings", "Tiers: T1, T2, T3", "Agents: planner, docs, coder, tester, reviewer, debugger, git", "Models: Opus 5.5, Sonnet 5.5, Haiku 5.5", "Skills: orchestrator 1, planner 1, docs 1, coder 1, tester 1, reviewer 2, debugger 1, git 1", "Next: run wf in a project folder."]) {
      assert.ok(result.io.lines.includes(line), `${line} in ${text}`);
    }
    assert.ok(!ANSI.test(text), "no color codes without a terminal");
    assert.equal(result.io.questions.length, 0, "--yes asks nothing");
  });

  test("the next install keeps the saved answers, and --reset or --skills-reset start from the defaults", async (t) => {
    const { go, flags, calls, saveChoices, paths } = setup(t);
    await go(["install", "--yes", "--skip-claude", ...flags]);
    saveChoices(REDUCED);
    const manifest = readManifest(paths).data;
    writeManifest(paths, { ...manifest, skills: { known: ["context-cache", "seo"], selection: { ...manifest.skills.selection, reviewer: ["context-cache"] } } }, createGuard(paths));
    const kept = await go(["install", "--yes", "--skip-claude", ...flags], { now: "2026-10-28T12:01:00Z" });
    assert.equal(kept.code, 0, kept.io.text());
    assert.deepEqual(choicesOf(calls.compile[1]), REDUCED);
    assert.deepEqual(calls.compile[1].selection.reviewer, ["context-cache"]);
    for (const line of ["Tiers: T1, T2", "Agents: planner, docs, coder, tester", "Models: Sonnet 5.5, Haiku 5.5", "note: T3 not installed: a T3-sized task runs as T2", "note: reviewer not installed: a coder of the tier reviews in a separate read-only round when asked", "note: debugger not installed: a repeated failure gets one more coder round, then the report", "note: git not installed: the work stays uncommitted and the report lists the git commands", "note: Opus 5.5 not installed: orchestrator runs on Sonnet 5.5"]) {
      assert.ok(kept.io.lines.includes(line), `${line} in ${kept.io.text()}`);
    }
    assert.deepEqual(readManifest(paths).data.choices, { ...REDUCED, known: KNOWN }, "the reduced setup survives a reinstall");
    for (const flag of ["--reset", "--skills-reset"]) {
      saveChoices(REDUCED);
      const reset = await go(["install", "--yes", "--skip-claude", flag, ...flags], { now: "2026-10-28T12:02:00Z" });
      assert.equal(reset.code, 0, reset.io.text());
      assert.deepEqual(choicesOf(calls.compile.at(-1)), ALL, flag);
      assert.deepEqual(calls.compile.at(-1).selection.reviewer, ["context-cache", "seo"], flag);
    }
  });

  test("choices saved before the debugger and the git agent existed get them ticked on the next install, and the new answer records them as known", async (t) => {
    const { go, flags, calls, paths } = setup(t);
    await go(["install", "--yes", "--skip-claude", ...flags]);
    const before = WORKERS.filter((name) => name !== "debugger" && name !== "git");
    const manifest = readManifest(paths).data;
    const lists = Object.fromEntries(Object.entries(manifest.skills.selection).filter(([role]) => role !== "debugger" && role !== "git"));
    writeManifest(
      paths,
      {
        ...manifest,
        choices: { ...REDUCED, known: { ...KNOWN, roles: before } },
        skills: { known: ["context-cache", "seo"], selection: { ...lists, reviewer: ["context-cache"] } }
      },
      createGuard(paths)
    );
    const next = await go(["install", "--yes", "--skip-claude", ...flags], { now: "2026-10-28T12:01:00Z" });
    assert.equal(next.code, 0, next.io.text());
    assert.deepEqual(choicesOf(calls.compile.at(-1)), { ...REDUCED, roles: [...REDUCED.roles, "debugger", "git"] }, "the reviewer stays unticked, the unknown debugger and git agent are ticked");
    assert.deepEqual(calls.compile.at(-1).selection.debugger, ["context-cache"], "the debugger gets its required skills");
    assert.deepEqual(calls.compile.at(-1).selection.git, ["context-cache"], "the git agent gets its required skills");
    assert.deepEqual(calls.compile.at(-1).selection.reviewer, ["context-cache"]);
    assert.ok(next.io.lines.includes("Agents: planner, docs, coder, tester, debugger, git"), next.io.text());
    assert.ok(!next.io.lines.some((line) => line.startsWith("note: debugger") || line.startsWith("note: git")), next.io.text());
    assert.deepEqual(readManifest(paths).data.choices, { ...REDUCED, roles: [...REDUCED.roles, "debugger", "git"], known: KNOWN });
    assert.ok(Object.hasOwn(readManifest(paths).data.skills.selection, "debugger"));
    assert.ok(Object.hasOwn(readManifest(paths).data.skills.selection, "git"));
  });

  test("a manifest with no saved choices, from before the install choices, installs everything, the debugger included", async (t) => {
    const { go, flags, calls, paths } = setup(t);
    await go(["install", "--yes", "--skip-claude", ...flags]);
    const manifest = readManifest(paths).data;
    delete manifest.choices;
    writeManifest(paths, manifest, createGuard(paths));
    const next = await go(["install", "--yes", "--skip-claude", ...flags], { now: "2026-10-28T12:01:00Z" });
    assert.equal(next.code, 0, next.io.text());
    assert.deepEqual(choicesOf(calls.compile.at(-1)), ALL);
    assert.deepEqual(readManifest(paths).data.choices, { ...ALL, known: KNOWN });
  });

  test("an unticked debugger in a terminal run is saved and stays unticked on the next install", async (t) => {
    const { go, flags, calls, paths } = setup(t);
    const without = WORKERS.filter((name) => name !== "debugger");
    const io = captureIo({ selections: scriptedSelections([undefined, without]), choices: () => "install" });
    const result = await go(["install", "--skip-claude", ...flags], { interactive: true, io });
    assert.equal(result.code, 0, io.text());
    const agents = io.calls.find((call) => call.title === "Which agents should wf install?");
    const item = agents.items.find((entry) => entry.value === "debugger");
    assert.equal(item.checked, true, "ticked by default");
    assert.equal(item.detail(["debugger"]), "Untick the debugger: a repeated failure gets one more coder round, then the report");
    assert.ok(!io.questions.includes("Skills for the debugger"), "no skills list for an agent that is not installed");
    assert.ok(io.lines.includes("  note: debugger not installed: a repeated failure gets one more coder round, then the report"), io.text());
    assert.deepEqual(readManifest(paths).data.choices, { ...ALL, roles: without, known: KNOWN });
    await go(["install", "--yes", "--skip-claude", ...flags], { now: "2026-10-28T12:01:00Z" });
    assert.deepEqual(choicesOf(calls.compile.at(-1)).roles, without);
  });

  test("a terminal runs the five steps and Install writes without a second question", async (t) => {
    const { go, flags, calls, paths } = setup(t);
    const io = captureIo({ selections: scriptedSelections([["t1", "t2"], ["planner", "docs", "coder", "tester"], [SONNET, HAIKU]]), choices: () => "install" });
    const result = await go(["install", "--skip-claude", ...flags], { interactive: true, io });
    assert.equal(result.code, 0, io.text());
    assert.deepEqual(io.questions, [
      "Which tiers should wf install?",
      "Which agents should wf install?",
      "Which models should wf use?",
      ...["orchestrator", "planner", "docs", "coder", "tester"].map((role) => `Skills for the ${role}`),
      "Install now?"
    ]);
    assert.deepEqual(choicesOf(calls.compile.at(-1)), REDUCED);
    assert.deepEqual(readManifest(paths).data.choices, { ...REDUCED, known: KNOWN });
    const text = io.text();
    const order = ["Step 1 of 5: Tiers", "Tiers: T1, T2 (T3 runs as T2)", "Step 4 of 5: Skills", "Step 5 of 5: Summary", "  orchestrator  main  wf:orchestrator  Sonnet 5.5*  medium", "Plan: ", "Summary: Install", "Applied ", "Next: run wf in a project folder."].map((marker) => text.indexOf(marker));
    assert.ok(order.every((at) => at >= 0), `${JSON.stringify(order)}\n${text}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "the steps, the summary, the plan and the result come in order");
    assert.equal(text.split("Plan: ").length, 2, "the plan is shown once, in the summary");
  });

  test("Change choices starts again at step 1 with the current answers ticked", async (t) => {
    const { go, flags, calls } = setup(t);
    const answers = ["change", "install"];
    const io = captureIo({ selections: scriptedSelections([["t1", "t2"]]), choices: () => answers.shift() });
    const result = await go(["install", "--skip-claude", ...flags], { interactive: true, io });
    assert.equal(result.code, 0, io.text());
    const tierLists = io.calls.filter((call) => call.title === "Which tiers should wf install?");
    assert.equal(tierLists.length, 2);
    assert.deepEqual(tierLists[1].items.map((item) => [item.value, item.checked]), [["t1", true], ["t2", true], ["t3", false]]);
    assert.equal(io.calls.filter((call) => call.kind === "single").length, 2);
    assert.deepEqual(choicesOf(calls.compile.at(-1)).tiers, ["t1", "t2"]);
    assert.ok(io.lines.includes("Summary: Change choices"));
  });

  test("an interactive run starts every list from the answers of the last install", async (t) => {
    const { go, flags, saveChoices } = setup(t);
    await go(["install", "--yes", "--skip-claude", ...flags]);
    saveChoices(REDUCED);
    const io = captureIo({ choices: () => "cancel" });
    await go(["install", "--skip-claude", ...flags], { interactive: true, io, now: "2026-10-28T12:01:00Z" });
    const [tiers, agents, models] = io.calls;
    assert.deepEqual(tiers.items.map((item) => item.checked), [true, true, false]);
    assert.deepEqual(agents.items.map((item) => [item.value, item.checked]), [["planner", true], ["docs", true], ["coder", true], ["tester", true], ["reviewer", false], ["debugger", false], ["git", false]]);
    assert.deepEqual(models.items.map((item) => item.checked), [false, true, true]);
    const fresh = captureIo({ choices: () => "cancel" });
    await go(["install", "--reset", "--skip-claude", ...flags], { interactive: true, io: fresh, now: "2026-10-28T12:02:00Z" });
    assert.ok(fresh.calls.slice(0, 3).every((call) => call.items.every((item) => item.checked)), "--reset ticks everything again");
  });

  test("Cancel at the summary writes nothing and exits 1", async (t) => {
    const { go, flags, paths } = setup(t);
    const io = captureIo({ choices: () => "cancel" });
    const result = await go(["install", "--skip-claude", ...flags], { interactive: true, io });
    assert.equal(result.code, 1);
    assert.ok(io.lines.includes("Cancelled: nothing was written."), io.text());
    assert.equal(fs.existsSync(paths.configHome), false);
  });

  test("a cancelled list at any step ends like Cancel on the summary: one status line, nothing written, exit 1", async (t) => {
    const { go, flags, paths } = setup(t);
    for (let at = 0; at < 4; at += 1) {
      const answers = [undefined, undefined, undefined, undefined];
      answers[at] = () => null;
      const io = captureIo({ selections: scriptedSelections(answers) });
      const result = await go(["install", "--skip-claude", ...flags], { interactive: true, io });
      assert.equal(result.code, 1, `cancel at list ${at + 1}`);
      assert.ok(io.lines.includes("Cancelled: nothing was written."), io.text());
      assert.ok(!io.text().includes("wf: install cancelled"), "no bare error line");
      assert.equal(io.questions.includes("Install now?"), false);
      assert.equal(fs.existsSync(paths.configHome), false);
    }
    const rich = captureIo({ selections: () => null });
    await go(["install", "--skip-claude", ...flags], { interactive: true, io: rich, ui: RICH });
    assert.ok(rich.lines.map(stripAnsi).includes("  \u2139 Cancelled: nothing was written."), "the same styled line as Cancel on the summary");
  });

  test("FORCE_COLOR on a pipe keeps the plain, stable install output", async (t) => {
    const { go, flags } = setup(t);
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
      written += chunk.toString();
    });
    const io = terminalIo({ input: new PassThrough(), output, env: { FORCE_COLOR: "1" }, platform: "darwin" });
    assert.deepEqual([io.ui.rich, io.ui.unicode, io.ui.color], [false, false, true]);
    const result = await go(["install", "--yes", "--skip-claude", ...flags], { io });
    assert.equal(result.code, 0, written);
    assert.match(written, /^wf install: /m);
    assert.match(written, /^Plan: \d+ create, 0 update, 0 remove, 0 unchanged$/m);
    assert.match(written, /^Tiers: T1, T2, T3$/m);
    assert.match(written, /^Next: run wf in a project folder\.$/m);
    assert.ok(!/[\u256d\u2714\u2139\u271a\u2026]/.test(written), "no box, icons or cut paths");
  });

  test("--dry-run in a terminal asks nothing and writes nothing", async (t) => {
    const { go, flags, paths } = setup(t);
    const io = captureIo();
    const result = await go(["install", "--dry-run", "--skip-claude", ...flags], { interactive: true, io });
    assert.equal(result.code, 0);
    assert.equal(io.questions.length, 0);
    assert.match(io.text(), /Dry run: \d+ changes, nothing written\./);
    assert.equal(fs.existsSync(paths.configHome), false);
  });

  test("--json asks nothing and prints one JSON object with the choices and the result", async (t) => {
    const { go, flags, paths } = setup(t);
    const io = captureIo();
    const result = await go(["install", "--json", "--skip-claude", ...flags], { interactive: true, io, ui: RICH });
    assert.equal(result.code, 0);
    assert.equal(io.lines.length, 1);
    assert.equal(io.questions.length, 0);
    const report = JSON.parse(io.lines[0]);
    assert.equal(report.command, "install");
    assert.equal(report.ok, true);
    assert.deepEqual({ tiers: report.choices.tiers, roles: report.choices.roles, models: report.choices.models }, ALL);
    assert.deepEqual(report.notes, []);
    assert.equal(report.written, true);
    assert.match(report.backup, /^\d{8}T\d{6}Z$/);
    assert.ok(report.messages.includes("Tiers: T1, T2, T3"));
    assert.ok(!ANSI.test(io.lines[0]), "JSON output is plain");
    assert.equal(readManifest(paths).schema, "wf.manifest/2");
  });

  test("--json reports an error inside the JSON object", async (t) => {
    const { go, flags, findings } = setup(t);
    findings.push({ level: "error", where: "registry.json", message: "broken" });
    const io = captureIo();
    const result = await go(["install", "--json", "--skip-claude", ...flags], { io });
    assert.equal(result.code, 1);
    const report = JSON.parse(io.lines[0]);
    assert.equal(report.ok, false);
    assert.match(report.error, /lint errors/);
    assert.ok(report.messages.includes("  error registry.json: broken"));
  });

  test("a rich terminal gets the header box, step icons, check marks and colors", async (t) => {
    const { go, flags } = setup(t);
    const io = captureIo({ choices: () => "install" });
    const result = await go(["install", "--skip-claude", ...flags], { interactive: true, io, ui: RICH });
    assert.equal(result.code, 0, io.text());
    const text = io.text();
    const plain = stripAnsi(text);
    assert.ok(ANSI.test(text), "colored");
    assert.ok(plain.includes("\u256d\u2500"), "a box");
    assert.ok(plain.includes("wf 2.1.0 \u00b7 installer"));
    assert.ok(plain.includes(INSTALL_ABOUT));
    assert.ok(plain.includes("Step 1 of 5  \u{1F4CA} Tiers"));
    assert.ok(plain.includes("Step 5 of 5  \u{1F4CB} Summary"));
    assert.ok(plain.includes("  \u2714 Lint: 0 errors, 0 warnings"));
    assert.ok(plain.includes("  \u2139 Claude Code: check skipped (--skip-claude)"));
    assert.ok(plain.includes("\u271a create"), "plan icons");
    assert.ok(plain.includes("Next: run wf in a project folder."));
    assert.ok(!/[\u2012-\u2015]/.test(plain), "no em or en dash");
  });

  test("a 60 column terminal keeps every installer line inside the width, long folder paths included", async (t) => {
    const { go, flags, paths } = setup(t);
    const narrow = createUi({ rich: true, unicode: true, color: true, columns: 60 });
    const io = captureIo({ selections: scriptedSelections([["t1", "t2"], ["planner", "docs", "coder", "tester"], [SONNET, HAIKU]]), choices: () => "install" });
    const result = await go(["install", "--skip-claude", ...flags], { interactive: true, io, ui: narrow });
    assert.equal(result.code, 0, io.text());
    const lines = io.lines.flatMap((line) => line.split("\n")).map(stripAnsi);
    for (const line of lines) assert.ok(visibleLength(line) <= 59, JSON.stringify(line));
    const config = lines.findIndex((line) => line.startsWith("  Config    "));
    assert.ok(config >= 0, "the Config row");
    const rows = [];
    for (let at = config; at < lines.length && (at === config || lines[at].startsWith(" ".repeat(12))); at += 1) rows.push(at === config ? lines[at].slice(12) : lines[at].trim());
    assert.equal(rows.join(""), paths.configHome, "the wrapped Config row still holds the whole path");
  });

  test("lint errors stop the install before anything is written", async (t) => {
    const { go, flags, findings, paths } = setup(t);
    findings.push({ level: "error", where: "skills/seo/SKILL.md", message: "description too long" });
    findings.push({ level: "warning", where: "registry.json", message: "minor" });
    const result = await go(["install", "--yes", "--skip-claude", ...flags]);
    assert.equal(result.code, 1);
    assert.match(result.io.text(), /error skills\/seo\/SKILL\.md: description too long/);
    assert.match(result.io.text(), /Lint: 1 errors, 1 warnings/);
    assert.equal(fs.existsSync(paths.configHome), false);
  });

  test("an old Claude Code refuses the install with the claude update hint", async (t) => {
    const { go, flags, paths } = setup(t);
    const result = await go(["install", "--yes", ...flags], { env: { WF_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_VERSION: "2.1.300" } });
    assert.equal(result.code, 1);
    assert.match(result.io.text(), /Claude Code 2\.1\.300 is older than 2\.1\.312\. Run: claude update/);
    assert.equal(fs.existsSync(paths.configHome), false);
  });

  test("a current Claude Code is recorded and the plugin is validated", async (t) => {
    const { go, flags, paths } = setup(t);
    const result = await go(["install", "--yes", ...flags], { env: { WF_CLAUDE_BIN: FAKE_CLAUDE } });
    assert.equal(result.code, 0, result.io.text());
    assert.match(result.io.text(), /^Claude Code 2\.1\.312$/m);
    assert.match(result.io.text(), /verify: claude plugin validate passed/);
    assert.equal(readManifest(paths).data.claudeVersion, "2.1.312");
  });

  test("a failing plugin validate exits 1 after writing and gives no next hint", async (t) => {
    const { go, flags, paths } = setup(t);
    const result = await go(["install", "--yes", ...flags], { env: { WF_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_VALIDATE: "fail" } });
    assert.equal(result.code, 1);
    assert.match(result.io.text(), /not rolled back/);
    assert.ok(!result.io.text().includes("Next: "));
    assert.equal(readManifest(paths).schema, "wf.manifest/2");
  });

  test("lint: errors exit 1, warnings exit 0, --self adds the repo checks", async (t) => {
    const { go, flags, findings, selfFindings, calls } = setup(t);
    findings.push({ level: "warning", where: "a", message: "w" });
    const clean = await go(["lint", ...flags]);
    assert.equal(clean.code, 0);
    assert.equal(calls.lintSelf, 0);
    assert.match(clean.io.text(), /wf lint: 0 errors, 1 warnings/);
    selfFindings.push({ level: "error", where: "lib/x.mjs:3", message: "comment" });
    const self = await go(["lint", "--self", ...flags]);
    assert.equal(self.code, 1);
    assert.equal(calls.lintSelf, 1);
    assert.match(self.io.text(), /error lib\/x\.mjs:3: comment/);
  });

  test("diff prints the choices and the plan, uses the saved answers and writes nothing", async (t) => {
    const { go, flags, paths, calls, saveChoices } = setup(t);
    const fresh = await go(["diff", ...flags]);
    assert.equal(fresh.code, 0);
    assert.match(fresh.io.text(), /Plan: \d+ changes against/);
    assert.ok(fresh.io.lines.includes("Tiers: T1, T2, T3"));
    assert.equal(fs.existsSync(paths.configHome), false);
    await go(["install", "--yes", "--skip-claude", ...flags]);
    saveChoices(REDUCED);
    const reduced = await go(["diff", ...flags]);
    assert.deepEqual(choicesOf(calls.compile.at(-1)), REDUCED);
    for (const line of ["Agents: planner, docs, coder, tester", "note: reviewer not installed: a coder of the tier reviews in a separate read-only round when asked", "note: debugger not installed: a repeated failure gets one more coder round, then the report", "note: git not installed: the work stays uncommitted and the report lists the git commands"]) {
      assert.ok(reduced.io.lines.includes(line), `${line} in ${reduced.io.text()}`);
    }
    await go(["diff", "--reset", ...flags]);
    assert.deepEqual(choicesOf(calls.compile.at(-1)), ALL);
  });

  test("uninstall and restore are wired", async (t) => {
    const { go, flags, paths } = setup(t);
    await go(["install", "--yes", "--skip-claude", ...flags]);
    assert.equal((await go(["uninstall", "--yes", ...flags], { now: "2026-10-28T12:01:00Z" })).code, 0);
    assert.equal(fs.existsSync(paths.pluginDir), false);
    assert.equal((await go(["restore", "--to", "20200101T000000Z", "--yes", ...flags])).code, 2);
    assert.equal((await go(["restore", "--yes", ...flags], { now: "2026-10-28T12:02:00Z" })).code, 0);
    assert.equal(fs.existsSync(path.join(paths.pluginDir, "agents", "coder-t1.md")), true);
    assert.equal(listBackups(paths).length, 3);
  });

  test("doctor is wired, reports a missing install and shows the saved choices", async (t) => {
    const { go, flags, saveChoices } = setup(t);
    const missing = await go(["doctor", "--skip-claude", ...flags]);
    assert.equal(missing.code, 1);
    assert.match(missing.io.text(), /fail {2}manifest/);
    await go(["install", "--yes", "--skip-claude", ...flags]);
    saveChoices(REDUCED);
    const result = await go(["doctor", "--skip-claude", ...flags]);
    assert.match(result.io.text(), /ok +choices +tiers T1, T2; agents [^;]+; models Sonnet 5\.5, Haiku 5\.5 \(T3 not installed, reviewer not installed, debugger not installed, git not installed\)/);
  });

  test("an unexpected error exits 1 with its message", async (t) => {
    const { go, flags, modules } = setup(t);
    modules.compile = () => {
      throw new Error("compile exploded");
    };
    const result = await go(["install", "--yes", "--skip-claude", ...flags]);
    assert.equal(result.code, 1);
    assert.match(result.io.text(), /wf: unexpected error: Error: compile exploded/);
  });
});

describe("hook node path", () => {
  test("a version manager node is recognised", () => {
    for (const nodePath of ["/Users/a/.nvm/versions/node/v24.16.0/bin/node", "/home/a/.local/share/fnm/node-versions/v22.1.0/installation/bin/node", "/home/a/.asdf/installs/nodejs/22.1.0/bin/node", "/home/a/.volta/tools/image/node/22.1.0/bin/node", "/home/a/.local/share/mise/installs/node/22/bin/node", "C:\\Users\\a\\.nvm\\versions\\node\\v22\\node.exe"]) {
      assert.equal(versionManagedNode(nodePath), true, nodePath);
    }
    for (const nodePath of ["/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node", "/usr/bin/node", "C:\\Program Files\\nodejs\\node.exe"]) assert.equal(versionManagedNode(nodePath), false, nodePath);
  });

  test("install warns about an nvm node when there is no local.json", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const notes = nodePathNotes({ nodePath: "/Users/a/.nvm/versions/node/v24.16.0/bin/node", appDir: root });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^warning: the hooks will run \/Users\/a\/\.nvm\/.+ every git and gh command in wf sessions is then refused.+"nodePath"/);
    assert.deepEqual(nodePathNotes({ nodePath: "/opt/homebrew/opt/node/bin/node", appDir: root }), []);
  });

  test("a local.json nodePath must run node 22 or newer, else the install stops", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, "local.json"), JSON.stringify({ nodePath: path.join(root, "missing-node") }));
    assert.throws(() => nodePathNotes({ nodePath: path.join(root, "missing-node"), appDir: root }), /local\.json: nodePath .+missing-node does not exist; the hooks need node 22 or newer.+Nothing was written\./);
    assert.deepEqual(nodePathNotes({ nodePath: process.execPath, appDir: root }), [], "a working local.json node gets no warning, version manager or not");
    assert.match(checkLocalNode(process.execPath, { run: () => ({ status: 0, stdout: "v20.11.0\n" }) }), /is node 20\.11\.0, older than 22/);
    assert.match(checkLocalNode(process.execPath, { run: () => ({ status: 1, stdout: "" }) }), /does not run as node/);
  });
});

describe("helpers", () => {
  test("savedSelection and savedSetup read only a v2 manifest answer", (t) => {
    const root = tmpRoot();
    t.after(() => cleanup(root));
    const paths = makePaths(root);
    assert.equal(savedSelection(readManifest(paths)), null);
    assert.equal(savedSetup(readManifest(paths)), null);
    writeManifest(paths, { schema: "wf.manifest/1", skills: { selection: {} } }, createGuard(paths));
    assert.equal(savedSelection(readManifest(paths)), null);
    assert.equal(savedSetup(readManifest(paths)), null);
    writeManifest(paths, { schema: "wf.manifest/2", skills: { known: ["a"], selection: { coder: ["a"] } } }, createGuard(paths));
    assert.deepEqual(savedSelection(readManifest(paths)), { selection: { coder: ["a"] }, skills: ["a"] });
    assert.deepEqual(savedSetup(readManifest(paths)), { choices: null, skills: { selection: { coder: ["a"] }, skills: ["a"] } });
    writeManifest(paths, { schema: "wf.manifest/2", choices: { tiers: ["t1"] } }, createGuard(paths));
    assert.deepEqual(savedSetup(readManifest(paths)), { choices: { tiers: ["t1"] }, skills: null });
  });

  test("lineMultiSelect toggles by number, keeps locked items, holds min and returns on enter", async () => {
    const answers = ["2 3", "1", ""];
    const printed = [];
    const items = [
      { label: "context-cache", value: "context-cache", checked: true, locked: true, hint: "required" },
      { label: "seo", value: "seo", checked: false, locked: false, hint: "search" },
      { label: "vitest", value: "vitest", checked: true, locked: false, hint: "" }
    ];
    const values = await lineMultiSelect({ title: "Skills for the reviewer", items }, async () => answers.shift(), (line) => printed.push(line));
    assert.deepEqual(values, ["context-cache", "seo"]);
    assert.ok(printed.includes("? Skills for the reviewer"));
    assert.ok(printed.some((line) => /\[x\] context-cache {2}\(required\)/.test(line)));
    const strict = ["", "1", ""];
    const picked = await lineMultiSelect({ title: "t", items: [{ label: "a", value: "a", checked: false }], min: 1 }, async () => strict.shift(), (line) => printed.push(line));
    assert.deepEqual(picked, ["a"]);
    assert.ok(printed.includes("  pick at least 1"));
  });

  test("TERM=dumb asks with the numbered line prompt and sends no cursor codes", async () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {
      throw new Error("a dumb terminal needs no raw mode");
    };
    const output = new PassThrough();
    output.isTTY = true;
    output.columns = 80;
    let written = "";
    output.on("data", (chunk) => {
      written += chunk.toString();
    });
    const io = terminalIo({ input, output, env: { TERM: "dumb" }, platform: "linux" });
    assert.deepEqual([io.interactive, io.ui.rich, io.ui.unicode, io.ui.color], [true, true, false, false]);
    const items = [{ label: "T1", value: "t1", checked: true }, { label: "T2", value: "t2", checked: true, hint: "word ".repeat(40) }];
    const picked = io.multiSelect({ title: "Which tiers should wf install?", items, min: 1 });
    input.write("2\n");
    input.write("\n");
    assert.deepEqual(await picked, ["t1"]);
    const chosen = io.select({ title: "Install now?", items: [{ value: "install", label: "Install" }, { value: "cancel", label: "Cancel" }] });
    input.write("2\n");
    assert.equal(await chosen, "cancel");
    assert.ok(written.includes("  ? Which tiers should wf install?"), written);
    assert.ok(written.includes("numbers to toggle, enter to accept"), written);
    assert.ok(written.includes("[ ] T2"), written);
    assert.ok(!written.includes("\u001b"), `no escape codes: ${JSON.stringify(written)}`);
    for (const line of written.split("\n")) assert.ok(line.length <= 79, `a long hint is cut to the width: ${JSON.stringify(line)}`);
    assert.ok(written.split("\n").some((line) => line.includes("[ ] T2  (word") && line.endsWith("...")), "the cut is marked with ASCII dots");
  });

  test("a capable terminal keeps the key-driven list", async () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => input;
    const output = new PassThrough();
    output.isTTY = true;
    let written = "";
    output.on("data", (chunk) => {
      written += chunk.toString();
    });
    const io = terminalIo({ input, output, env: { TERM: "xterm-256color" }, platform: "linux" });
    const picked = io.multiSelect({ title: "t", items: [{ label: "a", value: "a", checked: true }] });
    input.write("\r");
    assert.deepEqual(await picked, ["a"]);
    assert.ok(written.startsWith("\u001b[?25l"), "the key-driven list hides the cursor");
  });

  test("fitLine cuts a line to the width with ASCII dots and leaves short lines alone", () => {
    assert.equal(fitLine("x".repeat(100), 40), `${"x".repeat(36)}...`);
    assert.equal(fitLine("x".repeat(100), 40).length, 39);
    assert.equal(fitLine("short", 40), "short");
    assert.equal(fitLine("x".repeat(100), undefined), "x".repeat(100), "no width means no cut");
  });

  test("lineSelect picks by number and enter takes the first", async () => {
    const items = [{ value: "install", label: "Install" }, { value: "cancel", label: "Cancel", hint: "stop" }];
    const printed = [];
    assert.equal(await lineSelect({ title: "Install now?", items }, async () => "2", (line) => printed.push(line)), "cancel");
    assert.equal(await lineSelect({ title: "Install now?", items }, async () => "", () => {}), "install");
    const answers = ["9", "1"];
    assert.equal(await lineSelect({ title: "t", items }, async () => answers.shift(), () => {}), "install");
    assert.ok(printed.includes("   2 Cancel  (stop)"));
  });

  test("a bare node --test does not hang on the fixture hooks that read stdin", () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const name of ["guard.mjs", "context.mjs"]) {
      const result = spawnSync(process.execPath, ["--test", path.join(REPO_ROOT, "test", "data", "install", "hooks", name)], { env, encoding: "utf8", timeout: 20000 });
      assert.equal(result.signal, null, `${name} ended by itself`);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  });

  test("wf.mjs runs main and returns its exit code", () => {
    const help = spawnSync(process.execPath, [path.join(REPO_ROOT, "wf.mjs"), "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage: node wf\.mjs <command>/);
    const bad = spawnSync(process.execPath, [path.join(REPO_ROOT, "wf.mjs"), "bogus"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /unknown command: bogus/);
  });
});
