import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, loadSources } from "../lib/compile.mjs";
import { EFFORTS } from "../lib/lint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = loadSources(path.join(here, ".."));
const registry = sources.registry;
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const TIERS = ["t1", "t2", "t3", "t4", "t5"];
const TABLE = Object.freeze({
  planner: [[HAIKU, "medium"], [SONNET, "low"], [SONNET, "medium"], [SONNET, "high"], [OPUS, "high"]],
  docs: [[HAIKU, "low"], [HAIKU, "medium"], [HAIKU, "high"], [SONNET, "low"], [SONNET, "medium"]],
  coder: [[HAIKU, "low"], [HAIKU, "medium"], [HAIKU, "high"], [SONNET, "medium"], [SONNET, "high"]],
  tester: [[HAIKU, "low"], [HAIKU, "medium"], [HAIKU, "high"], [SONNET, "medium"], [SONNET, "high"]],
  reviewer: [[HAIKU, "medium"], [SONNET, "low"], [SONNET, "medium"], [SONNET, "high"], [OPUS, "high"]],
  debugger: [[SONNET, "low"], [SONNET, "medium"], [SONNET, "high"], [OPUS, "medium"], [OPUS, "high"]]
});
const POSIX_PATHS = Object.freeze({
  configHome: "/home/me/.claude",
  appDir: "/home/me/.claude/ai-agents-setup",
  pluginDir: "/home/me/.claude/ai-agents-setup/plugin",
  stateDir: "/home/me/.claude/ai-agents-setup/state",
  launcherDir: "/home/me/.local/bin"
});

describe("the real registry", () => {
  test("loads without problems", () => {
    assert.deepEqual(sources.problems, []);
  });

  test("every tiered worker has exactly t1 to t5", () => {
    for (const name of Object.keys(TABLE)) assert.deepEqual(Object.keys(registry.roles[name].tiers), TIERS, `${name}: tiers`);
  });

  for (const [name, cells] of Object.entries(TABLE)) {
    TIERS.forEach((tier, index) => {
      const [model, effort] = cells[index];
      test(`${name} at ${tier.toUpperCase()} runs on ${model} with ${effort} effort`, () => {
        assert.deepEqual(registry.roles[name].tiers[tier], { model, effort });
      });
    });
  }

  test("the orchestrator runs on Sonnet 5.5 with medium effort", () => {
    assert.equal(registry.roles.orchestrator.model, SONNET);
    assert.equal(registry.roles.orchestrator.effort, "medium");
    assert.equal(registry.roles.orchestrator.tiers, undefined);
  });

  test("the git agent is one agent on Haiku 5.5 with medium effort and has no tiers", () => {
    assert.equal(registry.roles.git.model, HAIKU);
    assert.equal(registry.roles.git.effort, "medium");
    assert.equal(registry.roles.git.tiers, undefined);
  });

  test("the plugin description names the five tiers", () => {
    assert.match(registry.plugin.description, /tier T1 to T5 workers/);
  });

  test("high effort appears only on the listed tier agents", () => {
    const high = [];
    for (const [name, role] of Object.entries(registry.roles)) {
      if (role.effort === "high") high.push(name);
      for (const [tier, variant] of Object.entries(role.tiers ?? {})) if (variant.effort === "high") high.push(`${name}-${tier}`);
    }
    assert.deepEqual(high.sort(), ["coder-t3", "coder-t5", "debugger-t3", "debugger-t5", "docs-t3", "planner-t4", "planner-t5", "reviewer-t4", "reviewer-t5", "tester-t3", "tester-t5"]);
  });

  test("every effort is a known effort and low is in use", () => {
    const efforts = [];
    for (const role of Object.values(registry.roles)) {
      if (role.effort) efforts.push(role.effort);
      for (const variant of Object.values(role.tiers ?? {})) efforts.push(variant.effort);
    }
    for (const effort of efforts) assert.ok(EFFORTS.includes(effort), `unknown effort ${effort}`);
    assert.ok(efforts.includes("low"));
    assert.deepEqual([...new Set(efforts)].sort(), ["high", "low", "medium"]);
  });

  test("every tiered model is declared in the registry models", () => {
    const declared = Object.keys(registry.models);
    for (const [name, role] of Object.entries(registry.roles)) {
      for (const [tier, variant] of Object.entries(role.tiers ?? {})) assert.ok(declared.includes(variant.model), `${name} ${tier}: ${variant.model}`);
    }
  });

  test("a default compile installs 32 agents and lists the T5 planner in the orchestrator table", () => {
    const result = compile(sources, { paths: POSIX_PATHS, nodePath: "/usr/local/bin/node", platform: "linux" });
    const agentFiles = result.files.filter((file) => file.base === "config" && /\/plugin\/agents\/[^/]+\.md$/.test(file.path));
    assert.equal(agentFiles.length, 32);
    const names = agentFiles.map((file) => path.posix.basename(file.path, ".md")).sort();
    const expected = ["orchestrator", "git", ...Object.keys(TABLE).flatMap((role) => TIERS.map((tier) => `${role}-${tier}`))].sort();
    assert.deepEqual(names, expected);
    const orchestrator = agentFiles.find((file) => file.path.endsWith("/agents/orchestrator.md")).content;
    assert.ok(orchestrator.includes("| planner | T5 | wf:planner-t5 | claude-opus-5-5 | high |"));
    assert.ok(orchestrator.includes("| docs | T5 | wf:docs-t5 | claude-sonnet-5-5 | medium |"));
    assert.ok(orchestrator.includes("| debugger | T4 | wf:debugger-t4 | claude-opus-5-5 | medium |"));
    assert.ok(orchestrator.includes("| git | all | wf:git | claude-haiku-5-5 | medium |"));
    assert.ok(orchestrator.includes("Everything is installed."));
    assert.match(orchestrator, /^model: claude-sonnet-5-5$/m);
  });
});
