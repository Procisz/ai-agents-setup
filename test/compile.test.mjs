import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_MODE,
  EXEC_MODE,
  agentDescription,
  compile,
  formatTokens,
  loadRegistry,
  loadSources,
  normalizeRoles,
  renderFrontmatter,
  renderPlaceholders
} from "../lib/compile.mjs";
import { parseFrontmatter } from "../lib/skills.mjs";
import { defaultSelection } from "../lib/select.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "data", "compile");
const tempRoots = [];

const POSIX_PATHS = Object.freeze({
  configHome: "/home/me/.claude",
  appDir: "/home/me/.claude/ai-agents-setup",
  pluginDir: "/home/me/.claude/ai-agents-setup/plugin",
  stateDir: "/home/me/.claude/ai-agents-setup/state",
  launcherDir: "/home/me/.local/bin"
});
const NODE = "/usr/local/bin/node";
const PLUGIN = "ai-agents-setup/plugin";
const WIN_HOME = "C:\\Users\\Me Too\\.claude";
const WIN_PATHS = Object.freeze({
  configHome: WIN_HOME,
  appDir: `${WIN_HOME}\\ai-agents-setup`,
  pluginDir: `${WIN_HOME}\\ai-agents-setup\\plugin`,
  stateDir: `${WIN_HOME}\\ai-agents-setup\\state`,
  launcherDir: "C:\\Users\\Me Too\\AppData\\Local\\wf"
});
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const AGENT_NAMES = [
  "coder-t1",
  "coder-t2",
  "coder-t3",
  "debugger-t1",
  "debugger-t2",
  "debugger-t3",
  "docs-t1",
  "docs-t2",
  "docs-t3",
  "git",
  "orchestrator",
  "planner-t1",
  "planner-t2",
  "planner-t3",
  "reviewer-t1",
  "reviewer-t2",
  "reviewer-t3",
  "tester-t1",
  "tester-t2",
  "tester-t3"
];

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-compile-"));
  tempRoots.push(dir);
  fs.cpSync(fixtureRoot, dir, { recursive: true });
  return dir;
}

function build(options = {}) {
  const sources = options.sources ?? loadSources(fixtureRoot);
  return compile(sources, { paths: POSIX_PATHS, nodePath: NODE, platform: "linux", ...options });
}

function fileAt(result, filePath, base = "config") {
  const file = result.files.find((item) => item.base === base && item.path === filePath);
  assert.ok(file, `missing output ${base}:${filePath}`);
  return file;
}

function agentFile(result, name) {
  return fileAt(result, `${PLUGIN}/agents/${name}.md`);
}

describe("loadSources", () => {
  test("reads the registry, roles, bodies, blocks, rules, skills and scripts", () => {
    const sources = loadSources(fixtureRoot);
    assert.deepEqual(sources.problems, []);
    assert.equal(sources.registry.schemaVersion, 2);
    assert.deepEqual(
      sources.roles.map((role) => role.name),
      ["orchestrator", "planner", "docs", "coder", "tester", "reviewer", "debugger", "git"]
    );
    assert.ok(sources.personas.orchestrator.startsWith("# Orchestrator"));
    assert.ok(sources.workerBlock.startsWith("## Worker rules"));
    assert.deepEqual(sources.rules, [{ source: "prompts/house-rules.md", target: "rules/wf-house-rules.md", text: "# House rules\n\nWrite code in English.\n" }]);
    assert.deepEqual(
      sources.hookScripts.map((entry) => entry.target),
      ["hooks/guard.mjs", "hooks/git.mjs", "hooks/context.mjs", "hooks/compact.mjs", "hooks/title.mjs"]
    );
    assert.deepEqual(
      sources.scripts.map((entry) => entry.target),
      ["scripts/wf-agents.mjs", "scripts/wf-clean.mjs", "scripts/wf-keepwarm.mjs"]
    );
    assert.deepEqual(
      sources.skills.map((skill) => skill.name),
      ["alpha", "beta", "gamma"]
    );
    assert.equal(sources.repoRoot, fixtureRoot);
  });

  test("records missing files as problems instead of throwing", () => {
    const root = copyFixture();
    fs.rmSync(path.join(root, "personas", "docs.md"));
    fs.rmSync(path.join(root, "prompts", "worker.md"));
    fs.rmSync(path.join(root, "scripts", "wf-clean.mjs"));
    const sources = loadSources(root);
    assert.equal(sources.personas.docs, undefined);
    assert.equal(sources.workerBlock, null);
    assert.equal(sources.scripts[1].text, null);
    assert.deepEqual(
      sources.problems.map((problem) => problem.where),
      ["personas/docs.md", "prompts/worker.md", "scripts/wf-clean.mjs"]
    );
  });

  test("refuses source paths outside the repository", () => {
    const root = copyFixture();
    const registry = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
    registry.rules[0].source = "../outside.md";
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(registry));
    const sources = loadSources(root);
    assert.match(sources.problems[0].message, /must be a relative path inside the repository/);
    assert.equal(sources.rules[0].text, null);
  });

  test("throws a clear error for a missing or broken registry", () => {
    const root = copyFixture();
    fs.writeFileSync(path.join(root, "registry.json"), "{ nope");
    assert.throws(() => loadSources(root), /registry.json is not valid JSON/);
    fs.rmSync(path.join(root, "registry.json"));
    assert.throws(() => loadRegistry(root), /registry.json is missing/);
  });

  test("normalizeRoles orders tier variants and names them role-tier", () => {
    const roles = normalizeRoles({ roles: { coder: { tools: ["Read"], tiers: { t3: { model: "m3", effort: "high" }, t1: { model: "m1", effort: "low" } } }, lead: { main: true, model: "m", effort: "medium" } } });
    assert.deepEqual(roles[0].variants, [
      { agent: "coder-t1", tier: "t1", model: "m1", effort: "low" },
      { agent: "coder-t3", tier: "t3", model: "m3", effort: "high" }
    ]);
    assert.deepEqual(roles[1].variants, [{ agent: "lead", tier: null, model: "m", effort: "medium" }]);
    assert.equal(roles[1].tools, null);
  });

  test("normalizeRoles gives a single role one agent named after it, with no tools unless it lists them", () => {
    const roles = normalizeRoles({ roles: { git: { single: true, model: "m", effort: "medium", tiers: { t1: { model: "x", effort: "low" } } }, ops: { single: true, tools: ["Read"], model: "m", effort: "low" } } });
    assert.equal(roles[0].single, true);
    assert.equal(roles[0].main, false);
    assert.deepEqual(roles[0].variants, [{ agent: "git", tier: null, model: "m", effort: "medium" }]);
    assert.equal(roles[0].tools, null);
    assert.deepEqual(roles[1].tools, ["Read"]);
  });

  test("normalizeRoles puts the cacheTtl of a role on each of its variants and on none when it has no cacheTtl", () => {
    const roles = normalizeRoles({
      roles: {
        coder: { cacheTtl: "1h", tools: ["Read"], tiers: { t2: { model: "m2", effort: "low" }, t1: { model: "m1", effort: "low" } } },
        git: { single: true, cacheTtl: "5m", model: "m", effort: "medium" },
        lead: { main: true, model: "m", effort: "medium" }
      }
    });
    assert.deepEqual(roles[0].variants, [
      { agent: "coder-t1", tier: "t1", model: "m1", effort: "low", cacheTtl: "1h" },
      { agent: "coder-t2", tier: "t2", model: "m2", effort: "low", cacheTtl: "1h" }
    ]);
    assert.deepEqual(roles[1].variants, [{ agent: "git", tier: null, model: "m", effort: "medium", cacheTtl: "5m" }]);
    assert.deepEqual(roles[2].variants, [{ agent: "lead", tier: null, model: "m", effort: "medium" }]);
    assert.equal("cacheTtl" in roles[2].variants[0], false);
  });
});

describe("compile on POSIX", () => {
  test("writes the 20 agents, the plugin files, the library, settings, the rule and the launcher", () => {
    const result = build();
    const paths = result.files.map((file) => `${file.base}:${file.path}`);
    assert.deepEqual(paths, [
      `config:${PLUGIN}/.claude-plugin/plugin.json`,
      ...AGENT_NAMES.map((name) => `config:${PLUGIN}/agents/${name}.md`),
      `config:${PLUGIN}/bin/wf-agents`,
      `config:${PLUGIN}/bin/wf-clean`,
      `config:${PLUGIN}/bin/wf-keepwarm`,
      `config:${PLUGIN}/hooks/compact.mjs`,
      `config:${PLUGIN}/hooks/config.json`,
      `config:${PLUGIN}/hooks/context.mjs`,
      `config:${PLUGIN}/hooks/git.mjs`,
      `config:${PLUGIN}/hooks/guard.mjs`,
      `config:${PLUGIN}/hooks/hooks.json`,
      `config:${PLUGIN}/hooks/title.mjs`,
      `config:${PLUGIN}/library/alpha/SKILL.md`,
      `config:${PLUGIN}/library/beta/SKILL.md`,
      `config:${PLUGIN}/library/beta/references/guide.md`,
      `config:${PLUGIN}/library/gamma/SKILL.md`,
      `config:${PLUGIN}/scripts/wf-agents.mjs`,
      `config:${PLUGIN}/scripts/wf-clean.mjs`,
      `config:${PLUGIN}/scripts/wf-keepwarm.mjs`,
      "config:ai-agents-setup/wf-settings.json",
      "config:rules/wf-house-rules.md",
      "launcher:wf"
    ]);
  });

  test("lists the agents with role, tier, model and effort", () => {
    const { agents } = build();
    assert.equal(agents.length, 20);
    assert.deepEqual(agents[0], { name: "orchestrator", agent: "wf:orchestrator", role: "orchestrator", tier: null, model: "claude-opus-5-5", effort: "medium" });
    assert.deepEqual(
      agents.find((agent) => agent.name === "planner-t3"),
      { name: "planner-t3", agent: "wf:planner-t3", role: "planner", tier: "t3", model: "claude-opus-5-5", effort: "high" }
    );
    assert.deepEqual(
      agents.find((agent) => agent.name === "coder-t1"),
      { name: "coder-t1", agent: "wf:coder-t1", role: "coder", tier: "t1", model: "claude-haiku-5-5", effort: "medium" }
    );
    assert.deepEqual(
      agents.find((agent) => agent.name === "reviewer-t2"),
      { name: "reviewer-t2", agent: "wf:reviewer-t2", role: "reviewer", tier: "t2", model: "claude-sonnet-5-5", effort: "high" }
    );
  });

  test("gives every file LF endings, a trailing newline and the right mode", () => {
    const result = build();
    for (const file of result.files) {
      assert.ok(!file.content.includes("\r"), `${file.path} has a carriage return`);
      assert.ok(file.content.endsWith("\n"), `${file.path} lacks a trailing newline`);
      const executable = file.base === "launcher" || file.path.includes("/bin/");
      assert.equal(file.mode, executable ? EXEC_MODE : CONFIG_MODE, file.path);
    }
  });

  test("is deterministic", () => {
    assert.deepEqual(build(), build());
  });

  test("builds worker frontmatter with name, description, tools, model, effort, the experimental cache TTL and color only", () => {
    const parsed = parseFrontmatter(agentFile(build(), "coder-t2").content);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.data, {
      name: "coder-t2",
      description: "Fixture coder. Delegated by wf:orchestrator only. Tier T2: Sonnet 5.5, medium effort.",
      tools: "Read, Glob, Grep, Write, Edit, Bash",
      model: "claude-sonnet-5-5",
      effort: "medium",
      experimental: { cacheTtl: "1h" },
      color: "green"
    });
  });

  test("writes the experimental cache TTL as an indented block between effort and color", () => {
    const worker = agentFile(build(), "tester-t2").content;
    assert.ok(worker.includes('\neffort: medium\nexperimental:\n  cacheTtl: "5m"\ncolor: yellow\n---\n'), worker.slice(0, 400));
    const coder = agentFile(build(), "coder-t2").content;
    assert.ok(coder.includes('\neffort: medium\nexperimental:\n  cacheTtl: "1h"\ncolor: green\n---\n'), coder.slice(0, 400));
    const orchestrator = agentFile(build(), "orchestrator").content;
    assert.ok(!orchestrator.includes("experimental"), "the orchestrator keeps the main thread cache, so no experimental block");
  });

  test("gives the orchestrator no tools line and no maxTurns, skills or autoCompactWindow anywhere", () => {
    const result = build();
    const parsed = parseFrontmatter(agentFile(result, "orchestrator").content);
    assert.deepEqual(Object.keys(parsed.data), ["name", "description", "model", "effort", "color"]);
    for (const name of AGENT_NAMES) {
      const keys = Object.keys(parseFrontmatter(agentFile(result, name).content).data);
      for (const banned of ["maxTurns", "skills", "autoCompactWindow"]) assert.ok(!keys.includes(banned), `${name} has ${banned}`);
    }
  });

  test("gives the single git agent no tools line, its own model and effort, and the worker block", () => {
    const result = build();
    const file = agentFile(result, "git");
    const parsed = parseFrontmatter(file.content);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.data, {
      name: "git",
      description: "Fixture git agent. Delegated by wf:orchestrator only. Every tier: Sonnet 5.5, medium effort.",
      model: "claude-sonnet-5-5",
      effort: "medium",
      experimental: { cacheTtl: "5m" },
      color: "cyan"
    });
    assert.ok(!/^tools:/m.test(file.content), "no tools line, so wf:git gets every tool");
    assert.ok(parsed.body.trimStart().startsWith("# Git\n\nYou are the wf git agent."), parsed.body);
    assert.ok(parsed.body.includes("## Worker rules"));
    assert.deepEqual(result.agents.find((agent) => agent.name === "git"), { name: "git", agent: "wf:git", role: "git", tier: null, model: "claude-sonnet-5-5", effort: "medium" });
    assert.ok(!result.files.some((item) => /\/agents\/git-t\d\.md$/.test(item.path)), "git has no tier variants");
  });

  test("tier variants share one body and differ only in frontmatter", () => {
    const result = build();
    const bodies = ["coder-t1", "coder-t2", "coder-t3"].map((name) => parseFrontmatter(agentFile(result, name).content).body);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(bodies[1], bodies[2]);
    assert.notEqual(agentFile(result, "coder-t1").content, agentFile(result, "coder-t3").content);
  });

  test("orders the body: persona, worker block, inlined skills, library index", () => {
    const body = parseFrontmatter(agentFile(build(), "tester-t1").content).body;
    const order = ["# Tester", "## Worker rules", '<wf-skill name="beta"', '<wf-skill name="gamma"', "## Skill library"].map((marker) => body.indexOf(marker));
    assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  test("leaves the worker block out of the orchestrator", () => {
    const content = agentFile(build(), "orchestrator").content;
    assert.ok(!content.includes("## Worker rules"));
  });

  test("inlines the selected skills with the installed SKILL.md path and no frontmatter", () => {
    const content = agentFile(build(), "coder-t1").content;
    const library = `${POSIX_PATHS.pluginDir}/library`;
    assert.ok(content.includes(`<wf-skill name="beta" path="${library}/beta/SKILL.md">\n# Beta\n\nRead ${library}/beta/references/guide.md for details.\n</wf-skill>`), content);
    assert.ok(content.includes(`<wf-skill name="gamma" path="${library}/gamma/SKILL.md">\n# Gamma\n\nGamma body for ${library}.\n</wf-skill>`), content);
    assert.ok(!content.includes("wf-default"), "skill frontmatter is not inlined");
  });

  test("lists every other installed skill in the library index with its description and path", () => {
    const content = agentFile(build(), "coder-t1").content;
    const index = content.slice(content.indexOf("## Skill library"));
    assert.ok(index.includes(`- alpha: Alpha process skill for the orchestrator.\n  ${POSIX_PATHS.pluginDir}/library/alpha/SKILL.md`), index);
    assert.ok(!index.includes("- beta:"), "an inlined skill is not listed again");
    assert.ok(!index.includes("- gamma:"), "an inlined skill is not listed again");
  });

  test("says so when every skill is inlined", () => {
    const selection = { ...defaultSelection(loadSources(fixtureRoot).skills), docs: ["alpha", "beta", "gamma"] };
    const content = agentFile(build({ selection }), "docs-t1").content;
    assert.ok(content.endsWith("## Skill library\n\nEvery installed skill is already loaded above.\n"), content.slice(-200));
  });

  test("follows the selection and always adds required skills", () => {
    const selection = { orchestrator: [], planner: ["gamma"], docs: [], coder: [], tester: [], reviewer: ["alpha"] };
    const result = build({ selection });
    const has = (name, skill) => agentFile(result, name).content.includes(`<wf-skill name="${skill}"`);
    assert.ok(has("orchestrator", "alpha"), "alpha is required by the orchestrator");
    assert.ok(has("tester-t2", "gamma"), "gamma is required by the tester");
    assert.ok(!has("tester-t2", "beta"), "beta is only a tester default and was not selected");
    assert.ok(has("planner-t2", "gamma"));
    assert.ok(has("reviewer-t3", "alpha"));
    assert.ok(!has("coder-t1", "beta"));
  });

  test("uses the default selection when none is given", () => {
    assert.deepEqual(build(), build({ selection: defaultSelection(loadSources(fixtureRoot).skills) }));
  });

  test("refuses a selection that names an unknown skill or is not a list", () => {
    assert.throws(() => build({ selection: { coder: ["nope"] } }), /selection.coder names unknown skill nope/);
    assert.throws(() => build({ selection: { coder: "beta" } }), /selection.coder must be a list/);
    assert.throws(() => build({ selection: ["beta"] }), /selection must be an object/);
  });

  test("replaces every placeholder in personas and the worker block", () => {
    const result = build();
    const orchestrator = agentFile(result, "orchestrator").content;
    assert.ok(orchestrator.includes("Zones: buffer from 500K, hand off at 800K, compaction at 850K of 1M."), orchestrator);
    assert.ok(orchestrator.includes(`Keep-warm pings after 58 minutes, and after 4 minutes for 5 minute agents, up to 30 minutes after their last work. Library: ${POSIX_PATHS.pluginDir}/library.`));
    assert.ok(orchestrator.includes("| Role | Tier | Agent | Model | Effort |"));
    assert.ok(orchestrator.includes("| orchestrator | main | wf:orchestrator | claude-opus-5-5 | medium |"));
    assert.ok(orchestrator.includes("| planner | T2 | wf:planner-t2 | claude-sonnet-5-5 | high |"));
    assert.ok(orchestrator.includes("| reviewer | T3 | wf:reviewer-t3 | claude-opus-5-5 | high |"));
    assert.ok(agentFile(result, "docs-t1").content.includes("Hand off at 800K: write the handoff note"));
    for (const file of result.files.filter((item) => item.path.includes("/agents/"))) {
      assert.ok(!/\{\{[A-Za-z]+\}\}/.test(file.content), `${file.path} keeps a placeholder`);
    }
  });

  test("copies the library with placeholders replaced in SKILL.md and references, keeping unknown ones in references", () => {
    const result = build();
    const skillMd = fileAt(result, `${PLUGIN}/library/beta/SKILL.md`).content;
    assert.ok(skillMd.startsWith("---\nname: beta\n"), "the library copy keeps the frontmatter");
    assert.ok(skillMd.includes(`Read ${POSIX_PATHS.pluginDir}/library/beta/references/guide.md`));
    const guide = fileAt(result, `${PLUGIN}/library/beta/references/guide.md`).content;
    assert.equal(guide, `# Beta guide\n\nInstalled at ${POSIX_PATHS.pluginDir}/library/beta. A template example keeps {{ count }} as written.\n`);
  });

  test("writes the plugin manifest", () => {
    assert.deepEqual(JSON.parse(fileAt(build(), `${PLUGIN}/.claude-plugin/plugin.json`).content), {
      name: "wf",
      version: "2.0.0",
      description: "Fixture plugin for the compile tests.",
      author: { name: "Procisz" }
    });
  });

  test("writes hooks.json in the exec form with absolute paths and names the compact module (D123)", () => {
    const guard = `${POSIX_PATHS.pluginDir}/hooks/guard.mjs`;
    const context = `${POSIX_PATHS.pluginDir}/hooks/context.mjs`;
    const title = `${POSIX_PATHS.pluginDir}/hooks/title.mjs`;
    assert.deepEqual(JSON.parse(fileAt(build(), `${PLUGIN}/hooks/hooks.json`).content), {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: NODE, args: [guard], if: "Bash(*git*)", timeout: 10, onFailure: "block" },
              { type: "command", command: NODE, args: [guard], if: "Bash(*gh *)", timeout: 10, onFailure: "block" }
            ]
          },
          { matcher: "Monitor", hooks: [{ type: "command", command: NODE, args: [guard], timeout: 10, onFailure: "block" }] }
        ],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: NODE, args: [context], timeout: 10 }] },
          { matcher: "Write", hooks: [{ type: "command", command: NODE, args: [title], timeout: 10 }] }
        ],
        SessionStart: [{ matcher: "clear", hooks: [{ type: "command", command: NODE, args: [title], timeout: 10 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: NODE, args: [title], timeout: 15 }] }],
        PreCompact: [{ hooks: [{ type: "command", command: NODE, args: [context, "precompact"], timeout: 10 }] }]
      },
      modules: ["./compact.mjs"]
    });
  });

  test("only the guard handlers block when the hook cannot start; the context hooks never block", () => {
    const hooks = JSON.parse(fileAt(build(), `${PLUGIN}/hooks/hooks.json`).content).hooks;
    for (const group of hooks.PreToolUse) for (const handler of group.hooks) assert.equal(handler.onFailure, "block", `${group.matcher} guard handler`);
    for (const event of ["PostToolUse", "UserPromptSubmit", "PreCompact"]) for (const group of hooks[event]) for (const handler of group.hooks) assert.equal(handler.onFailure, undefined, `${event} context handler`);
  });

  test("renders the nudge cadence from the registry, not a fixed 50K and 5 calls", () => {
    const root = copyFixture();
    const registryFile = path.join(root, "registry.json");
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    registry.context.bufferStepTokens = 100000;
    registry.context.overEveryCalls = 3;
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
    fs.appendFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "\nNotices every further {{bufferStepTokens}} tokens, then every {{overEveryCalls}} tool calls.\n");
    const result = build({ sources: loadSources(root) });
    const library = fileAt(result, `${PLUGIN}/library/alpha/SKILL.md`).content;
    assert.ok(library.includes("Notices every further 100K tokens, then every 3 tool calls."), library);
  });

  test("writes config.json with the absolute zones and the state folder", () => {
    const text = fileAt(build(), `${PLUGIN}/hooks/config.json`).content;
    assert.deepEqual(JSON.parse(text), {
      window: 1000000,
      warnTokens: 500000,
      handoffTokens: 800000,
      compactTokens: 850000,
      bufferStepTokens: 50000,
      overEveryCalls: 5,
      stateDir: POSIX_PATHS.stateDir,
      keepwarmMinutes: 58,
      keepwarmPollSeconds: 20,
      keepwarmShortMinutes: 4,
      keepwarmShortMaxMinutes: 30,
      cacheTtl: { planner: "1h", docs: "5m", coder: "1h", tester: "5m", reviewer: "5m", debugger: "1h", git: "5m" }
    });
    assert.deepEqual(Object.keys(JSON.parse(text)), [
      "window",
      "warnTokens",
      "handoffTokens",
      "compactTokens",
      "bufferStepTokens",
      "overEveryCalls",
      "stateDir",
      "keepwarmMinutes",
      "keepwarmPollSeconds",
      "keepwarmShortMinutes",
      "keepwarmShortMaxMinutes",
      "cacheTtl"
    ]);
  });

  test("copies the hook and script sources and writes sh wrappers for the scripts", () => {
    const result = build();
    assert.equal(fileAt(result, `${PLUGIN}/hooks/guard.mjs`).content, 'export const name = "guard";\n');
    assert.equal(fileAt(result, `${PLUGIN}/scripts/wf-keepwarm.mjs`).content, 'process.stdout.write("wf-keepwarm\\n");\n');
    assert.equal(
      fileAt(result, `${PLUGIN}/bin/wf-clean`).content,
      `#!/bin/sh\nexec '${NODE}' '${POSIX_PATHS.pluginDir}/scripts/wf-clean.mjs' "$@"\n`
    );
    assert.ok(!result.files.some((file) => file.path.endsWith(".cmd")), "no .cmd files outside Windows");
  });

  test("writes wf-settings.json with the Concise output style, ultracode off, the compact tool allowed, the two Agent deny rules and the unused tools deny (D118, D122, D123)", () => {
    assert.deepEqual(JSON.parse(fileAt(build(), "ai-agents-setup/wf-settings.json").content), { outputStyle: "Concise", ultracode: false, permissions: { allow: ["mcp__wf__compact"], deny: ["Agent(model:*)", "Agent(effort:*)", "Artifact", "Workflow", "ScheduleWakeup", "SendFeedback", "ReportFindings", "ListAgents"] } });
  });

  test("writes the rule file to its target", () => {
    assert.equal(fileAt(build(), "rules/wf-house-rules.md").content, "# House rules\n\nWrite code in English.\n");
  });

  test("writes the POSIX launcher exactly as the plan shows", () => {
    assert.equal(
      fileAt(build(), "wf", "launcher").content,
      [
        "#!/bin/sh",
        "export BASH_DEFAULT_TIMEOUT_MS='600000'",
        "export BASH_MAX_TIMEOUT_MS='600000'",
        "export CLAUDE_CODE_THRIFTY_SONIC='0'",
        "export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='1'",
        "export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='86.74'",
        `exec claude --plugin-dir '${POSIX_PATHS.pluginDir}' --settings '${POSIX_PATHS.appDir}/wf-settings.json' --agent wf:orchestrator "$@"`,
        ""
      ].join("\n")
    );
  });

  test("never sets CLAUDE_CODE_AUTO_COMPACT_WINDOW or autoCompactWindow in any output", () => {
    for (const file of build().files) {
      assert.ok(!file.content.includes("CLAUDE_CODE_AUTO_COMPACT_WINDOW"), file.path);
      assert.ok(!file.content.includes("autoCompactWindow"), file.path);
    }
  });

  test("quotes paths with spaces and single quotes for sh", () => {
    const home = "/home/o'brien/my config";
    const paths = {
      configHome: home,
      appDir: `${home}/ai-agents-setup`,
      pluginDir: `${home}/ai-agents-setup/plugin`,
      stateDir: `${home}/ai-agents-setup/state`,
      launcherDir: "/home/o'brien/bin"
    };
    const result = build({ paths, nodePath: "/opt/node $HOME/bin/node" });
    const launcher = fileAt(result, "wf", "launcher").content;
    assert.ok(launcher.includes(`--plugin-dir '/home/o'\\''brien/my config/ai-agents-setup/plugin'`), launcher);
    const wrapper = fileAt(result, `${PLUGIN}/bin/wf-agents`).content;
    assert.equal(wrapper, `#!/bin/sh\nexec '/opt/node $HOME/bin/node' '/home/o'\\''brien/my config/ai-agents-setup/plugin/scripts/wf-agents.mjs' "$@"\n`);
    const hooks = JSON.parse(fileAt(result, `${PLUGIN}/hooks/hooks.json`).content);
    assert.equal(hooks.hooks.PostToolUse[0].hooks[0].args[0], "/home/o'brien/my config/ai-agents-setup/plugin/hooks/context.mjs");
  });

  test("derives output paths from paths, so a custom config home works", () => {
    const paths = { ...POSIX_PATHS, appDir: "/home/me/.claude/wf-app", pluginDir: "/home/me/.claude/wf-app/plugin" };
    const result = build({ paths });
    assert.ok(result.files.some((file) => file.path === "wf-app/plugin/agents/orchestrator.md"));
    assert.ok(result.files.some((file) => file.path === "wf-app/wf-settings.json"));
  });
});

describe("compile on Windows", () => {
  function buildWindows() {
    return build({ paths: WIN_PATHS, nodePath: WIN_NODE, platform: "win32" });
  }

  test("adds wf.cmd, the Git Bash wf and .cmd wrappers for the scripts", () => {
    const result = buildWindows();
    assert.deepEqual(
      result.files.filter((file) => file.base === "launcher").map((file) => file.path),
      ["wf", "wf.cmd"]
    );
    assert.deepEqual(
      result.files.filter((file) => file.path.includes("/bin/")).map((file) => file.path),
      ["wf-agents", "wf-agents.cmd", "wf-clean", "wf-clean.cmd", "wf-keepwarm", "wf-keepwarm.cmd"].map((name) => `${PLUGIN}/bin/${name}`)
    );
    assert.ok(result.files.some((file) => file.path === `${PLUGIN}/agents/coder-t1.md`), "output paths stay POSIX relative paths");
  });

  test("writes wf.cmd with set lines and the same arguments", () => {
    const content = fileAt(buildWindows(), "wf.cmd", "launcher").content;
    assert.equal(
      content,
      [
        "@echo off",
        "setlocal",
        'set "BASH_DEFAULT_TIMEOUT_MS=600000"',
        'set "BASH_MAX_TIMEOUT_MS=600000"',
        'set "CLAUDE_CODE_THRIFTY_SONIC=0"',
        'set "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1"',
        'set "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=86.74"',
        `claude --plugin-dir "${WIN_PATHS.pluginDir}" --settings "${WIN_PATHS.appDir}\\wf-settings.json" --agent wf:orchestrator %*`,
        ""
      ].join("\r\n")
    );
  });

  test("writes the Git Bash launcher with forward slashes", () => {
    const content = fileAt(buildWindows(), "wf", "launcher").content;
    assert.ok(content.includes("--plugin-dir 'C:/Users/Me Too/.claude/ai-agents-setup/plugin' --settings 'C:/Users/Me Too/.claude/ai-agents-setup/wf-settings.json'"), content);
    assert.ok(!content.includes("\r"));
  });

  test("writes .cmd wrappers with native paths and sh wrappers with forward slashes", () => {
    const result = buildWindows();
    assert.equal(
      fileAt(result, `${PLUGIN}/bin/wf-clean.cmd`).content,
      `@echo off\r\n"${WIN_NODE}" "${WIN_PATHS.pluginDir}\\scripts\\wf-clean.mjs" %*\r\n`
    );
    assert.equal(
      fileAt(result, `${PLUGIN}/bin/wf-clean`).content,
      `#!/bin/sh\nexec 'C:/Program Files/nodejs/node.exe' 'C:/Users/Me Too/.claude/ai-agents-setup/plugin/scripts/wf-clean.mjs' "$@"\n`
    );
  });

  test("keeps native paths in hooks.json and config.json", () => {
    const result = buildWindows();
    const hooks = JSON.parse(fileAt(result, `${PLUGIN}/hooks/hooks.json`).content);
    assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, WIN_NODE);
    const powershell = hooks.hooks.PreToolUse.find((group) => group.matcher === "PowerShell");
    assert.deepEqual(powershell.hooks.map((handler) => handler.if), ["PowerShell(*git*)", "PowerShell(*gh *)"], "the PowerShell tool is guarded on Windows");
    assert.deepEqual(hooks.hooks.PreCompact[0].hooks[0].args, [`${WIN_PATHS.pluginDir}\\hooks\\context.mjs`, "precompact"]);
    assert.equal(JSON.parse(fileAt(result, `${PLUGIN}/hooks/config.json`).content).stateDir, WIN_PATHS.stateDir);
  });

  test("uses forward slashes for paths inside agent and skill text", () => {
    const result = buildWindows();
    const coder = agentFile(result, "coder-t1").content;
    assert.ok(coder.includes('<wf-skill name="beta" path="C:/Users/Me Too/.claude/ai-agents-setup/plugin/library/beta/SKILL.md">'), coder);
    assert.ok(coder.includes("Read C:/Users/Me Too/.claude/ai-agents-setup/plugin/library/beta/references/guide.md for details."), coder);
  });

  test("escapes percent signs for cmd.exe", () => {
    const home = "C:\\Users\\100%\\.claude";
    const paths = { configHome: home, appDir: `${home}\\ai-agents-setup`, pluginDir: `${home}\\ai-agents-setup\\plugin`, stateDir: `${home}\\ai-agents-setup\\state`, launcherDir: "C:\\bin" };
    const result = build({ paths, nodePath: WIN_NODE, platform: "win32" });
    assert.ok(fileAt(result, "wf.cmd", "launcher").content.includes('--plugin-dir "C:\\Users\\100%%\\.claude\\ai-agents-setup\\plugin"'));
  });
});

describe("compile errors", () => {
  test("refuses missing paths or node path", () => {
    const sources = loadSources(fixtureRoot);
    assert.throws(() => compile(sources, { nodePath: NODE, platform: "linux" }), /paths is required/);
    assert.throws(() => compile(sources, { paths: { ...POSIX_PATHS, stateDir: "" }, nodePath: NODE }), /paths.stateDir must be an absolute path/);
    assert.throws(() => compile(sources, { paths: POSIX_PATHS, platform: "linux" }), /nodePath is required/);
    assert.throws(() => compile(sources, { paths: { ...POSIX_PATHS, pluginDir: "/elsewhere/plugin" }, nodePath: NODE, platform: "linux" }), /pluginDir must be inside configHome/);
  });

  test("refuses unknown placeholders in a persona, the worker block or a skill body", () => {
    const persona = copyFixture();
    fs.appendFileSync(path.join(persona, "personas", "docs.md"), "\n{{nope}}\n");
    assert.throws(() => build({ sources: loadSources(persona) }), /personas\/docs.md: unknown placeholder \{\{nope\}\}/);
    const worker = copyFixture();
    fs.appendFileSync(path.join(worker, "prompts", "worker.md"), "\n{{skillDir}}\n");
    assert.throws(() => build({ sources: loadSources(worker) }), /prompts\/worker.md: unknown placeholder \{\{skillDir\}\} \(it works only inside a skill body\)/);
    const skill = copyFixture();
    fs.appendFileSync(path.join(skill, "skills", "alpha", "SKILL.md"), "\n{{nope}}\n");
    assert.throws(() => build({ sources: loadSources(skill) }), /skills\/alpha\/SKILL.md: unknown placeholder \{\{nope\}\}/);
  });

  test("template text that is not an identifier placeholder stays as written in a skill body", () => {
    const skill = copyFixture();
    fs.appendFileSync(path.join(skill, "skills", "alpha", "SKILL.md"), "\n- run: vitest run --shard=${{ matrix.shard }}/3 and {{ spaced }}\n");
    const library = fileAt(build({ sources: loadSources(skill) }), `${PLUGIN}/library/alpha/SKILL.md`).content;
    assert.ok(library.includes("--shard=${{ matrix.shard }}/3 and {{ spaced }}"), library);
  });

  test("refuses a missing persona body, worker block, script or rule", () => {
    const cases = [
      [["personas", "coder.md"], /the body of role coder \(personas\/coder.md\) is missing/],
      [["prompts", "worker.md"], /the worker block is missing/],
      [["hooks", "git.mjs"], /hook script hooks\/git.mjs is missing/],
      [["scripts", "wf-agents.mjs"], /script scripts\/wf-agents.mjs is missing/],
      [["prompts", "house-rules.md"], /rule prompts\/house-rules.md is missing/]
    ];
    for (const [parts, pattern] of cases) {
      const root = copyFixture();
      fs.rmSync(path.join(root, ...parts));
      assert.throws(() => build({ sources: loadSources(root) }), pattern);
    }
  });

  test("refuses a binary file in a skill", () => {
    const root = copyFixture();
    fs.writeFileSync(path.join(root, "skills", "beta", "logo.png"), Buffer.from([0x89, 0x00, 0x01]));
    assert.throws(() => build({ sources: loadSources(root) }), /skill beta holds a file that is not text: logo.png/);
  });

  test("refuses a target that escapes its folder", () => {
    const sources = loadSources(fixtureRoot);
    const broken = { ...sources, rules: [{ ...sources.rules[0], target: "../rules/x.md" }] };
    assert.throws(() => build({ sources: broken }), /rule target "..\/rules\/x.md" must be a plain relative path/);
  });
});

describe("helpers", () => {
  test("formatTokens prints M for millions and K for thousands", () => {
    assert.equal(formatTokens(1000000), "1M");
    assert.equal(formatTokens(2000000), "2M");
    assert.equal(formatTokens(850000), "850K");
    assert.equal(formatTokens(500000), "500K");
    assert.equal(formatTokens(1234), "1234");
  });

  test("renderFrontmatter quotes only values that need it", () => {
    assert.equal(
      renderFrontmatter([
        ["name", "coder-t1"],
        ["description", "Uses wf:orchestrator: yes"],
        ["tools", "Read, Glob"],
        ["skip", undefined],
        ["word", "true"],
        ["number", "1.5"]
      ]),
      '---\nname: coder-t1\ndescription: "Uses wf:orchestrator: yes"\ntools: Read, Glob\nword: "true"\nnumber: "1.5"\n---\n'
    );
  });

  test("renderFrontmatter writes a plain object value as an indented block of quoted scalars", () => {
    assert.equal(
      renderFrontmatter([
        ["effort", "high"],
        ["experimental", { cacheTtl: "5m" }],
        ["color", "red"]
      ]),
      '---\neffort: high\nexperimental:\n  cacheTtl: "5m"\ncolor: red\n---\n'
    );
  });

  test("renderPlaceholders keeps unknown names when not strict and avoids replacement patterns", () => {
    assert.equal(renderPlaceholders("a {{x}} {{y}}", { x: "$& $1" }, "w", { strict: false }), "a $& $1 {{y}}");
    assert.throws(() => renderPlaceholders("{{y}}", {}, "where"), /where: unknown placeholder \{\{y\}\}/);
  });

  test("agentDescription adds the tier, model and effort for workers only", () => {
    const registry = loadSources(fixtureRoot).registry;
    const roles = normalizeRoles(registry);
    const coder = roles.find((role) => role.name === "coder");
    assert.equal(agentDescription(registry, coder, coder.variants[2]), "Fixture coder. Delegated by wf:orchestrator only. Tier T3: Sonnet 5.5, high effort.");
    const main = roles.find((role) => role.main);
    assert.equal(agentDescription(registry, main, main.variants[0]), registry.roles.orchestrator.description);
  });
});

describe("compile with install choices", () => {
  const REDUCED = { tiers: ["t1", "t2"], roles: ["planner", "docs", "coder", "tester"], models: ["claude-sonnet-5-5", "claude-haiku-5-5"] };

  function agentNames(result) {
    return result.files
      .filter((file) => file.path.startsWith(`${PLUGIN}/agents/`))
      .map((file) => path.posix.basename(file.path, ".md"))
      .sort();
  }

  test("the default choices give the same build as no choices", () => {
    assert.deepEqual(build({ choices: { tiers: ["t1", "t2", "t3"], roles: ["planner", "docs", "coder", "tester", "reviewer", "debugger", "git"], models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] } }), build());
  });

  test("writes only the chosen tier variants of the chosen roles", () => {
    const result = build({ choices: REDUCED });
    assert.deepEqual(agentNames(result), ["coder-t1", "coder-t2", "docs-t1", "docs-t2", "orchestrator", "planner-t1", "planner-t2", "tester-t1", "tester-t2"]);
    assert.deepEqual(result.agents.map((agent) => agent.name), ["orchestrator", "planner-t1", "planner-t2", "docs-t1", "docs-t2", "coder-t1", "coder-t2", "tester-t1", "tester-t2"]);
    assert.ok(result.files.some((file) => file.path === `${PLUGIN}/library/alpha/SKILL.md`), "the skill library stays complete");
  });

  test("moves an agent whose model is unticked to the nearest ticked model and keeps its effort", () => {
    const result = build({ choices: REDUCED });
    const parsed = parseFrontmatter(agentFile(result, "orchestrator").content);
    assert.equal(parsed.data.model, "claude-sonnet-5-5");
    assert.equal(parsed.data.effort, "medium");
    assert.deepEqual(result.agents[0], { name: "orchestrator", agent: "wf:orchestrator", role: "orchestrator", tier: null, model: "claude-sonnet-5-5", effort: "medium", remappedFrom: "claude-opus-5-5" });
    assert.ok(!Object.hasOwn(result.agents.find((agent) => agent.name === "coder-t2"), "remappedFrom"));
    const t2 = build({ choices: { ...REDUCED, models: ["claude-opus-5-5", "claude-haiku-5-5"] } });
    const coder = parseFrontmatter(agentFile(t2, "coder-t2").content).data;
    assert.equal(coder.model, "claude-opus-5-5", "Sonnet sits between Opus and Haiku: the tie goes to the stronger model");
    assert.equal(coder.description, "Fixture coder. Delegated by wf:orchestrator only. Tier T2: Opus 5.5, medium effort.");
  });

  test("the agent table lists only the installed agents with the models they run on", () => {
    const orchestrator = agentFile(build({ choices: REDUCED }), "orchestrator").content;
    const table = orchestrator.split("\n").filter((line) => line.startsWith("| "));
    assert.deepEqual(table, [
      "| Role | Tier | Agent | Model | Effort |",
      "| --- | --- | --- | --- | --- |",
      "| orchestrator | main | wf:orchestrator | claude-sonnet-5-5 | medium |",
      "| planner | T1 | wf:planner-t1 | claude-haiku-5-5 | high |",
      "| planner | T2 | wf:planner-t2 | claude-sonnet-5-5 | high |",
      "| docs | T1 | wf:docs-t1 | claude-haiku-5-5 | medium |",
      "| docs | T2 | wf:docs-t2 | claude-haiku-5-5 | medium |",
      "| coder | T1 | wf:coder-t1 | claude-haiku-5-5 | medium |",
      "| coder | T2 | wf:coder-t2 | claude-sonnet-5-5 | medium |",
      "| tester | T1 | wf:tester-t1 | claude-haiku-5-5 | medium |",
      "| tester | T2 | wf:tester-t2 | claude-sonnet-5-5 | medium |"
    ]);
  });

  test("renders {{setupNotes}} with one line per missing tier, role and moved model", () => {
    const orchestrator = agentFile(build({ choices: REDUCED }), "orchestrator").content;
    assert.ok(
      orchestrator.includes(
        [
          "## Setup",
          "",
          "- Tier T3 is not installed: run a T3-sized task as T2 and say so in the summary.",
          "- The reviewer is not installed: when the user asks for a review, a coder of the task's tier does a separate read-only review round with the code-review skill.",
          "- The debugger is not installed: a failure that comes back for the same reason gets one more coder fix round when the phase's cap allows; when that round does not clear it, it goes to the report.",
          "- The git agent is not installed: leave the work uncommitted and list the git commands in the report.",
          "- Model Opus 5.5 is not installed: wf:orchestrator runs on Sonnet 5.5 with its effort unchanged.",
          ""
        ].join("\n")
      ),
      orchestrator
    );
    assert.ok(agentFile(build(), "orchestrator").content.includes("## Setup\n\nEverything is installed.\n"));
  });

  test("the real orchestrator names only installed tier agents, whatever tiers are chosen", () => {
    const sources = loadSources(path.join(here, ".."));
    const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
    for (const roles of [["planner", "docs", "coder", "tester", "reviewer", "debugger", "git"], ["planner", "docs", "coder", "tester", "reviewer"]]) {
      for (const tiers of [["t1"], ["t1", "t3"], ["t3"], ["t1", "t2", "t3"]]) {
        const result = build({ sources, choices: { roles, models, tiers } });
        const installed = new Set(result.agents.map((agent) => agent.agent));
        const body = agentFile(result, "orchestrator").content;
        const named = [...body.matchAll(/wf:[a-z]+-t\d+/g)].map((match) => match[0]);
        assert.ok(named.length > 0, "the agent table names the tier agents");
        for (const name of named) assert.ok(installed.has(name), `tiers ${tiers}, roles ${roles}: ${name} is not installed`);
      }
    }
  });

  test("with planner, docs agent, tester and git left out, the orchestrator's flow names each only next to its fallback (D112, D115)", () => {
    const sources = loadSources(path.join(here, ".."));
    const result = build({ sources, choices: { tiers: ["t1", "t2", "t3"], roles: ["coder"], models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] } });
    const body = agentFile(result, "orchestrator").content;
    const cut = body.indexOf("<wf-skill");
    assert.ok(cut > 0, "the orchestrator inlines its skills after the persona");
    const lines = body.slice(0, cut).split("\n").filter((line) => /^\d+\. /.test(line) || line.includes("git writes are"));
    const roles = [[/\bthe planner\b/, "planner"], [/\bthe docs agent\b/, "docs agent"], [/\bthe tester\b/, "tester"], [/`wf:git`/, "git agent"]];
    let named = 0;
    for (const line of lines) {
      for (const [pattern, name] of roles) {
        if (!pattern.test(line)) continue;
        named += 1;
        assert.match(line, /\belse\b|or with no tester|when it is installed|only with the git agent installed/, `${name} is named without its fallback: ${line}`);
      }
    }
    assert.ok(named >= 6, `the flow and setup steps name the optional roles (${named})`);
  });

  test("the fallback roles are pointed at the skill of the role they replace", () => {
    const sources = loadSources(path.join(here, ".."));
    const result = build({ sources, choices: { tiers: ["t1", "t2"], roles: ["coder"], models: ["claude-sonnet-5-5", "claude-haiku-5-5"] } });
    const library = `${POSIX_PATHS.pluginDir}/library`;
    const coder = agentFile(result, "coder-t1").content;
    assert.ok(coder.includes(`Read ${library}/code-review/SKILL.md`), "a coder's review-only round reads code-review (D112)");
    assert.ok(coder.includes(`Read ${library}/execution-plan/SKILL.md`), "a coder's plan-only round reads execution-plan (D112)");
    assert.ok(coder.includes(`first read ${library}/docs-writing/SKILL.md`), "the coder's docs steps read docs-writing");
    assert.ok(coder.includes(`${library}/testing/SKILL.md`), "the coder's tests read testing");
    assert.ok(coder.includes("Whoever writes new tests: expected values come from summary.md and plan.md"), "the testing skill guards a coder's own tests");
  });

  test("the coder is always installed, and an unticked planner is missing at every tier (D112)", () => {
    const smallest = build({ choices: { tiers: ["t1"], roles: [], models: ["claude-haiku-5-5"] } });
    assert.deepEqual(agentNames(smallest), ["coder-t1", "orchestrator"]);
    const notes = agentFile(smallest, "orchestrator").content;
    assert.ok(notes.includes("- The planner is not installed: a coder of the task's tier writes plan.md in a plan-only round before implementation."), "the planner runs at T1 too, so a missing one needs its fallback at T1");
    assert.ok(notes.includes("- The docs agent is not installed: the coder does the docs steps of plan.md in its package."));
    assert.ok(notes.includes("- The tester is not installed: the coder writes and runs the tests after its code."));
    assert.ok(notes.includes("- The reviewer is not installed: when the user asks for a review, a coder of the task's tier does a separate read-only review round with the code-review skill."));
    assert.ok(notes.includes("- The git agent is not installed: leave the work uncommitted and list the git commands in the report."));
    assert.ok(notes.includes("- Tier T2 is not installed: run a T2-sized task as T1 and say so in the summary."));
    const withPlanner = build({ choices: { tiers: ["t1"], roles: ["planner", "coder"], models: ["claude-haiku-5-5"] } });
    assert.deepEqual(agentNames(withPlanner), ["coder-t1", "orchestrator", "planner-t1"]);
    assert.ok(!agentFile(withPlanner, "orchestrator").content.includes("The planner is not installed"));
  });

  test("the git agent is one agent for every installed tier, and unticked it leaves its fallback rule (D115)", () => {
    for (const tiers of [["t1"], ["t3"], ["t1", "t2", "t3"]]) {
      const result = build({ choices: { tiers, roles: ["coder", "git"], models: ["claude-sonnet-5-5"] } });
      assert.deepEqual(agentNames(result).filter((name) => name.startsWith("git")), ["git"], `tiers ${tiers}`);
      const orchestrator = agentFile(result, "orchestrator").content;
      assert.ok(orchestrator.includes("| git | all | wf:git | claude-sonnet-5-5 | medium |"), orchestrator);
      assert.ok(!orchestrator.includes("The git agent is not installed"));
    }
    const without = build({ choices: { tiers: ["t1", "t2", "t3"], roles: ["planner", "docs", "coder", "tester", "reviewer", "debugger"], models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] } });
    assert.ok(!agentNames(without).includes("git"));
    const orchestrator = agentFile(without, "orchestrator").content;
    assert.ok(!orchestrator.includes("wf:git"), "the agent table lists no git agent");
    assert.ok(orchestrator.includes("## Setup\n\n- The git agent is not installed: leave the work uncommitted and list the git commands in the report.\n"), orchestrator);
  });

  test("writes the debugger variants with their tools, color, models and efforts (D110)", () => {
    const result = build();
    const want = { "debugger-t1": ["claude-sonnet-5-5", "Sonnet 5.5"], "debugger-t2": ["claude-opus-5-5", "Opus 5.5"], "debugger-t3": ["claude-opus-5-5", "Opus 5.5"] };
    for (const [name, [model, label]] of Object.entries(want)) {
      const parsed = parseFrontmatter(agentFile(result, name).content);
      assert.deepEqual(parsed.errors, []);
      assert.deepEqual(parsed.data, {
        name,
        description: `Fixture debugger. Delegated by wf:orchestrator only. Tier ${name.slice(-2).toUpperCase()}: ${label}, high effort.`,
        tools: "Read, Glob, Grep, Write, Edit, Bash",
        model,
        effort: "high",
        experimental: { cacheTtl: "1h" },
        color: "orange"
      });
      assert.ok(parsed.body.includes("# Debugger") && parsed.body.includes("## Worker rules"), `${name}: persona and worker block`);
    }
    assert.deepEqual(
      result.agents.filter((agent) => agent.role === "debugger").map((agent) => [agent.agent, agent.tier, agent.model, agent.effort]),
      [
        ["wf:debugger-t1", "t1", "claude-sonnet-5-5", "high"],
        ["wf:debugger-t2", "t2", "claude-opus-5-5", "high"],
        ["wf:debugger-t3", "t3", "claude-opus-5-5", "high"]
      ]
    );
    const table = agentFile(result, "orchestrator").content.split("\n").filter((line) => line.startsWith("| debugger "));
    assert.deepEqual(table, [
      "| debugger | T1 | wf:debugger-t1 | claude-sonnet-5-5 | high |",
      "| debugger | T2 | wf:debugger-t2 | claude-opus-5-5 | high |",
      "| debugger | T3 | wf:debugger-t3 | claude-opus-5-5 | high |"
    ]);
  });

  test("without the debugger no debugger agent is written and the orchestrator gets its fallback rule", () => {
    const result = build({ choices: { tiers: ["t1", "t2", "t3"], roles: ["planner", "docs", "coder", "tester", "reviewer", "git"], models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] } });
    assert.ok(!agentNames(result).some((name) => name.startsWith("debugger-")));
    const orchestrator = agentFile(result, "orchestrator").content;
    assert.ok(!orchestrator.includes("wf:debugger-t"), "the agent table lists no debugger");
    assert.ok(orchestrator.includes("## Setup\n\n- The debugger is not installed: a failure that comes back for the same reason gets one more coder fix round when the phase's cap allows; when that round does not clear it, it goes to the report.\n"), orchestrator);
  });

  test("the real debugger inlines debugging and context-cache, and the other roles keep debugging in their library", () => {
    const sources = loadSources(path.join(here, ".."));
    const result = build({ sources, selection: defaultSelection(sources.skills) });
    const library = `${POSIX_PATHS.pluginDir}/library`;
    for (const name of ["debugger-t1", "debugger-t2", "debugger-t3"]) {
      const content = agentFile(result, name).content;
      for (const skill of ["context-cache", "debugging"]) assert.ok(content.includes(`<wf-skill name="${skill}" path="${library}/${skill}/SKILL.md">`), `${name} inlines ${skill}`);
      assert.ok(content.includes("Status: done | handoff | blocked"), `${name}: the worker block is included`);
    }
    for (const name of ["orchestrator", "coder-t2", "tester-t2", "reviewer-t2"]) {
      const content = agentFile(result, name).content;
      assert.ok(!content.includes('<wf-skill name="debugging"'), `${name} does not inline debugging`);
      assert.ok(content.includes(`- debugging: `) && content.includes(`  ${library}/debugging/SKILL.md`), `${name} lists debugging in its skill library`);
    }
  });

  test("refuses choices with unknown or empty lists", () => {
    assert.throws(() => build({ choices: { ...REDUCED, tiers: ["t9"] } }), /compile: choices.tiers names unknown tier t9/);
    assert.throws(() => build({ choices: { ...REDUCED, models: [] } }), /compile: choices.models needs at least one model/);
    assert.throws(() => build({ choices: "all" }), /compile: choices must be an object/);
  });

  test("a reduced build is deterministic and leaves no placeholder", () => {
    const result = build({ choices: REDUCED });
    assert.deepEqual(result, build({ choices: REDUCED }));
    for (const file of result.files.filter((item) => item.path.includes("/agents/"))) assert.ok(!/\{\{[A-Za-z]+\}\}/.test(file.content), file.path);
  });
});
