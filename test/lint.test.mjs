import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSources } from "../lib/compile.mjs";
import { MAIN_PLACEHOLDERS, countFindings, findComments, formatFindings, lintRegistrySchema, lintSelf, lintSources, lintText, listSelfFiles, reducedChoices } from "../lib/lint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "data", "compile");
const tempRoots = [];
const EM = String.fromCodePoint(0x2014);
const EN = String.fromCodePoint(0x2013);
const FIGURE = String.fromCodePoint(0x2012);
const BAR = String.fromCodePoint(0x2015);

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "wf-lint-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function copyFixture() {
  const dir = tempDir();
  fs.cpSync(fixtureRoot, dir, { recursive: true });
  return dir;
}

function readRegistry(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
}

function writeRegistry(root, registry) {
  fs.writeFileSync(path.join(root, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
}

function lintWith(change) {
  const root = copyFixture();
  const registry = readRegistry(root);
  const result = change(registry, root);
  writeRegistry(root, result ?? registry);
  return lintSources(loadSources(root));
}

function readRegistryWith(change) {
  const registry = readRegistry(fixtureRoot);
  change(registry);
  return registry;
}

function errors(findings) {
  return findings.filter((item) => item.level === "error");
}

function assertError(findings, pattern, where) {
  const hit = errors(findings).find((item) => pattern.test(item.message) && (where === undefined || item.where === where));
  assert.ok(hit, `expected an error matching ${pattern}${where ? ` at ${where}` : ""}, got ${JSON.stringify(findings, null, 1)}`);
}

describe("lintSources on the fixture", () => {
  test("finds nothing in the clean fixture", () => {
    assert.deepEqual(lintSources(loadSources(fixtureRoot)), []);
  });

  test("reports loader problems such as a missing persona body", () => {
    const root = copyFixture();
    fs.rmSync(path.join(root, "personas", "tester.md"));
    assertError(lintSources(loadSources(root)), /role tester body is missing/, "personas/tester.md");
  });

  test("refuses a non-object registry", () => {
    assert.deepEqual(lintSources({ registry: [] }), [{ level: "error", where: "registry.json", message: "registry.json must hold a JSON object" }]);
  });
});

describe("registry schema", () => {
  test("refuses unknown keys at every level", () => {
    const findings = lintWith((registry) => {
      registry.extra = 1;
      registry.context.windowSize = 1;
      registry.roles.coder.maxTurns = 30;
      registry.roles.coder.tiers.t1.temperature = 0;
      registry.roles.coder.tiers.t6 = { model: "claude-haiku-5-5", effort: "low" };
    });
    assertError(findings, /unknown key extra/);
    assertError(findings, /unknown key context.windowSize/);
    assertError(findings, /unknown key roles.coder.maxTurns/);
    assertError(findings, /unknown key roles.coder.tiers.t1.temperature/);
    assertError(findings, /roles.coder.tiers.t6: unknown key; use t1, t2, t3, t4 or t5/);
  });

  test("reports missing keys and wrong types", () => {
    const findings = lintWith((registry) => {
      delete registry.launcher;
      registry.schemaVersion = 1;
      registry.context.window = "1M";
      registry.rules = {};
    });
    assertError(findings, /missing required key launcher/);
    assertError(findings, /schemaVersion must be one of 2, found 1/);
    assertError(findings, /context.window must be an integer/);
    assertError(findings, /rules must be a list/);
  });

  test("lintRegistrySchema accepts the fixture registry", () => {
    assert.deepEqual(lintRegistrySchema(readRegistry(fixtureRoot)), []);
  });
});

describe("install section", () => {
  test("is required and takes only models and requiredRoles", () => {
    assertError(lintWith((registry) => {
      delete registry.install;
    }), /missing required key install/);
    assertError(lintWith((registry) => {
      registry.install.tiers = ["t1"];
    }), /unknown key install.tiers/);
  });

  test("models must list every registry model once, strongest first", () => {
    const findings = lintWith((registry) => {
      registry.install.models = ["claude-opus-5-5", "claude-opus-5-5", "claude-mythic-9"];
    });
    assertError(findings, /install.models: claude-mythic-9 is not in models/);
    assertError(findings, /install.models: claude-opus-5-5 is listed twice/);
    assertError(findings, /install.models must list every model, strongest first; claude-sonnet-5-5 is missing/);
  });

  test("requiredRoles must be worker roles with a variant on every tier", () => {
    const findings = lintWith((registry) => {
      delete registry.roles.docs.tiers.t1;
      registry.install.requiredRoles = ["coder", "orchestrator", "docs", "writer", "git"];
    });
    assertError(findings, /install.requiredRoles: orchestrator is not a worker role/);
    assertError(findings, /install.requiredRoles: writer is not a worker role/);
    assertError(findings, /install.requiredRoles: docs has no t1 variant, so it cannot be needed by every tier/);
    assert.ok(!errors(findings).some((item) => /requiredRoles: (?:coder|git)/.test(item.message)), "the coder has every tier and a single role serves every tier");
  });

  test("the main persona must hold {{agentTable}} and {{setupNotes}}", () => {
    assert.deepEqual(MAIN_PLACEHOLDERS, ["agentTable", "setupNotes"]);
    const findings = lintWith((registry, root) => {
      const file = path.join(root, "personas", "orchestrator.md");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("{{setupNotes}}", "notes"));
    });
    assertError(findings, /the main persona must hold \{\{setupNotes\}\}/, "personas/orchestrator.md");
    assert.ok(!errors(findings).some((item) => /must hold \{\{agentTable\}\}/.test(item.message)));
  });

  test("{{setupNotes}} is a known placeholder in any persona", () => {
    const findings = lintWith((registry, root) => {
      fs.appendFileSync(path.join(root, "personas", "coder.md"), "\n{{setupNotes}}\n");
    });
    assert.deepEqual(errors(findings), []);
  });

  test("the smallest setup is compiled and checked too: the first tier, the required roles, the lightest model", () => {
    const sources = loadSources(fixtureRoot);
    assert.deepEqual(reducedChoices(sources), { tiers: ["t1"], roles: ["coder"], models: ["claude-haiku-5-5"] });
    const broken = { ...sources, registry: { ...sources.registry, install: { ...sources.registry.install, requiredRoles: [] } } };
    assert.deepEqual(reducedChoices(broken).roles, []);
    assert.deepEqual(reducedChoices({ ...sources, roles: [] }), null);
  });
});

describe("roles", () => {
  test("requires the seven wf roles and no others", () => {
    const findings = lintWith((registry) => {
      registry.roles.writer = { ...registry.roles.docs, body: "personas/docs.md" };
      delete registry.roles.reviewer;
      delete registry.roles.debugger;
    });
    assertError(findings, /roles.writer: unknown role; wf roles are orchestrator, planner, docs, coder, tester, reviewer, debugger/);
    assertError(findings, /roles.reviewer is missing/);
    assertError(findings, /roles.debugger is missing/);
  });

  test("a missing debugger persona is reported with its registry path", () => {
    const root = copyFixture();
    fs.rmSync(path.join(root, "personas", "debugger.md"));
    assertError(lintSources(loadSources(root)), /role debugger body is missing/, "personas/debugger.md");
  });

  test("requires exactly one main role with model and effort and no tools", () => {
    const findings = lintWith((registry) => {
      registry.roles.orchestrator.tools = ["Read"];
      delete registry.roles.orchestrator.effort;
    });
    assertError(findings, /roles.orchestrator.tools: the main role takes no tools/);
    assertError(findings, /roles.orchestrator.effort is required for the main role/);
    assertError(
      lintWith((registry) => {
        registry.roles.coder.main = true;
      }),
      /exactly one role must have main: true, found 2/
    );
  });

  test("refuses unknown models and efforts", () => {
    const findings = lintWith((registry) => {
      registry.roles.coder.tiers.t2.model = "claude-sonnet-5";
      registry.roles.coder.tiers.t3.effort = "extreme";
      registry.roles.orchestrator.model = "opus";
    });
    assertError(findings, /roles.coder.tiers.t2.model claude-sonnet-5 is not in models/);
    assertError(findings, /roles.coder.tiers.t3.effort extreme must be one of low, medium, high, xhigh, max/);
    assertError(findings, /roles.orchestrator.model opus is not in models/);
  });

  test("accepts a t4 and a t5 variant on a worker", () => {
    const findings = lintWith((registry) => {
      registry.roles.coder.tiers.t4 = { model: "claude-sonnet-5-5", effort: "high" };
      registry.roles.coder.tiers.t5 = { model: "claude-sonnet-5-5", effort: "high" };
    });
    assert.deepEqual(errors(findings).filter((item) => /tiers\.t[45]/.test(item.message)), []);
    assert.deepEqual(errors(lintRegistrySchema(readRegistryWith((registry) => {
      registry.roles.coder.tiers.t4 = { model: "claude-sonnet-5-5", effort: "high" };
      registry.roles.coder.tiers.t5 = { model: "claude-sonnet-5-5", effort: "high" };
    }))), []);
  });

  test("refuses t0 and t6 as tier keys and names the five allowed", () => {
    const findings = lintWith((registry) => {
      registry.roles.coder.tiers.t0 = { model: "claude-haiku-5-5", effort: "low" };
      registry.roles.coder.tiers.t6 = { model: "claude-haiku-5-5", effort: "low" };
    });
    assertError(findings, /roles.coder.tiers.t0: unknown key; use t1, t2, t3, t4 or t5/);
    assertError(findings, /roles.coder.tiers.t6: unknown key; use t1, t2, t3, t4 or t5/);
  });

  test("accepts effort low on a tier", () => {
    const findings = lintWith((registry) => {
      registry.roles.coder.tiers.t3.effort = "low";
    });
    assert.deepEqual(errors(findings), []);
  });

  test("refuses unknown tools, worker-only bans and duplicates", () => {
    const findings = lintWith((registry) => {
      registry.roles.coder.tools = ["Read", "Agent", "Skill", "Telepathy", "Read"];
    });
    assertError(findings, /roles.coder.tools: unknown tool Telepathy/);
    assertError(findings, /roles.coder.tools: workers may not have Agent/);
    assertError(findings, /roles.coder.tools: workers may not have Skill/);
    assertError(findings, /roles.coder.tools: Read is listed twice/);
  });

  test("requires worker tools and tiers and keeps model and effort per tier", () => {
    const findings = lintWith((registry) => {
      delete registry.roles.docs.tools;
      registry.roles.docs.tiers = {};
      registry.roles.tester.model = "claude-haiku-5-5";
    });
    assertError(findings, /roles.docs.tools: a worker needs a tools list/);
    assertError(findings, /roles.docs.tiers: a worker needs at least one tier/);
    assertError(findings, /roles.tester.model: a worker sets model and effort per tier/);
  });

  test("a single role sets model and effort on the role, takes no tiers and lists tools only to limit them", () => {
    const findings = lintWith((registry) => {
      registry.roles.git.tiers = { t1: { model: "claude-haiku-5-5", effort: "low" } };
      delete registry.roles.git.effort;
      registry.roles.git.tools = [];
    });
    assertError(findings, /roles.git.tiers: a single role has one agent for every tier/);
    assertError(findings, /roles.git.effort is required for a single role/);
    assertError(findings, /roles.git.tools: leave tools out to give the agent every tool, or list at least one/);
    assertError(lintWith((registry) => void (registry.roles.git.tools = ["Read", "Agent"])), /roles.git.tools: workers may not have Agent/);
    assert.deepEqual(errors(lintWith((registry) => void (registry.roles.git.tools = ["Read", "Bash"]))), []);
  });

  test("a role is either main or single", () => {
    assertError(lintWith((registry) => void (registry.roles.orchestrator.single = true)), /roles.orchestrator.single: a role is either main or single, not both/);
  });

  test("refuses unknown colors and empty descriptions", () => {
    const findings = lintWith((registry) => {
      registry.roles.coder.color = "magenta";
      registry.roles.docs.description = " ";
    });
    assertError(findings, /roles.coder.color magenta is not a Claude Code agent color/);
    assertError(findings, /roles.docs.description is empty/);
  });

  test("requires a 5m or 1h cacheTtl on every worker and no cacheTtl on the main role", () => {
    assertError(
      lintWith((registry) => {
        delete registry.roles.coder.cacheTtl;
      }),
      /roles.coder.cacheTtl must be "5m" or "1h"/
    );
    assertError(
      lintWith((registry) => {
        registry.roles.tester.cacheTtl = "10m";
      }),
      /roles.tester.cacheTtl must be "5m" or "1h"/
    );
    assertError(
      lintWith((registry) => {
        registry.roles.git.cacheTtl = "1d";
      }),
      /roles.git.cacheTtl must be "5m" or "1h"/
    );
    assertError(
      lintWith((registry) => {
        registry.roles.orchestrator.cacheTtl = "1h";
      }),
      /roles.orchestrator.cacheTtl: the main role keeps the default cache of the main thread/
    );
    assert.deepEqual(errors(lintWith(() => {})), []);
  });
});

describe("context and launcher", () => {
  test("requires ordered zones", () => {
    assertError(
      lintWith((registry) => {
        registry.context.handoffTokens = 400000;
      }),
      /0 < warnTokens < handoffTokens < compactTokens < window/
    );
  });

  test("keeps the keep-warm ping before the 60 minute cache expiry", () => {
    assertError(
      lintWith((registry) => {
        registry.context.keepwarmMinutes = 60;
      }),
      /keepwarmMinutes must be between 1 and 59/
    );
  });

  test("keeps the short keep-warm between 1 and 4 minutes, under the 5 minute cache, with its cap above it", () => {
    assertError(
      lintWith((registry) => {
        registry.context.keepwarmShortMinutes = 5;
      }),
      /context.keepwarmShortMinutes must be between 1 and 4: the 5 minute cache expires at 5/
    );
    assertError(
      lintWith((registry) => {
        registry.context.keepwarmShortMinutes = 0;
      }),
      /context.keepwarmShortMinutes must be between 1 and 4/
    );
    assertError(
      lintWith((registry) => {
        registry.context.keepwarmShortMaxMinutes = 4;
      }),
      /context.keepwarmShortMaxMinutes must be above keepwarmShortMinutes/
    );
    assertError(
      lintWith((registry) => {
        delete registry.context.keepwarmShortMaxMinutes;
      }),
      /missing required key context.keepwarmShortMaxMinutes/
    );
    assert.deepEqual(errors(lintWith((registry) => void (registry.context.keepwarmShortMinutes = 1))), []);
  });

  test("accepts the experimental cacheTtl key that every compiled worker carries", () => {
    assert.deepEqual(errors(lintSources(loadSources(fixtureRoot))), []);
  });

  test("checks that the percent override puts the trigger at compactTokens", () => {
    assertError(
      lintWith((registry) => {
        registry.context.autoCompactPctOverride = "85";
        registry.launcher.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "85";
      }),
      /puts the compaction trigger at 833000 tokens .* not at compactTokens 850000/
    );
  });

  test("requires the launcher env percent to equal the registry value", () => {
    assertError(
      lintWith((registry) => {
        registry.launcher.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "86.7";
      }),
      /launcher.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE must equal context.autoCompactPctOverride \("86.74"\)/
    );
  });

  test("requires every model to have the full window", () => {
    assertError(
      lintWith((registry) => {
        registry.models["claude-haiku-5-5"].window = 200000;
      }),
      /models.claude-haiku-5-5.window 200000 differs from context.window 1000000/
    );
  });

  test("refuses unsafe launcher env names and values and the launcher agent mismatch", () => {
    const findings = lintWith((registry) => {
      registry.launcher.env.lower_case = "1";
      registry.launcher.env.HOME = "/tmp";
      registry.launcher.env.QUOTED = "a'b";
      registry.launcher.agent = "wf:coder-t1";
    });
    assertError(findings, /launcher.env.lower_case: names are upper case/);
    assertError(findings, /launcher.env.HOME may not be set by the launcher/);
    assertError(findings, /launcher.env.QUOTED: the value may not hold quotes/);
    assertError(findings, /launcher.agent must be wf:orchestrator/);
  });

  test("requires both deny rules in wfSettings", () => {
    assertError(
      lintWith((registry) => {
        registry.wfSettings.permissions.deny = ["Agent(model:*)"];
      }),
      /wfSettings.permissions.deny must hold Agent\(effort:\*\)/
    );
  });

  test("requires a deny rule for every tool wf never uses, so wf sessions do not load it (D118)", () => {
    const findings = lintWith((registry) => {
      registry.wfSettings.permissions.deny = registry.wfSettings.permissions.deny.filter((rule) => rule !== "Artifact" && rule !== "Workflow");
    });
    assertError(findings, /wfSettings.permissions.deny must hold Artifact so wf sessions do not load a tool wf never uses/);
    assertError(findings, /wfSettings.permissions.deny must hold Workflow so wf sessions do not load a tool wf never uses/);
  });

  test("requires ultracode false in wfSettings, so a wf session never runs standing Workflow orchestration (D122)", () => {
    const pattern = /wfSettings.ultracode must be false so a wf session never runs standing Workflow orchestration/;
    assertError(lintWith((registry) => void delete registry.wfSettings.ultracode), pattern);
    assertError(lintWith((registry) => void (registry.wfSettings.ultracode = true)), pattern);
    assert.deepEqual(errors(lintWith((registry) => void (registry.wfSettings.ultracode = false))), []);
  });

  test("requires the compact tool in the allow list and never in the deny list, so the orchestrator compacts without a prompt (D123)", () => {
    assertError(
      lintWith((registry) => void delete registry.wfSettings.permissions.allow),
      /wfSettings.permissions.allow must hold mcp__wf__compact so the orchestrator compacts without a permission prompt/
    );
    assertError(
      lintWith((registry) => void registry.wfSettings.permissions.deny.push("mcp__wf__compact")),
      /wfSettings.permissions.deny must not hold mcp__wf__compact/
    );
  });

  test("requires the compact module in hookScripts and a plugin name that keeps the tool name mcp__wf__compact (D123)", () => {
    const findings = lintWith((registry) => {
      registry.hookScripts = registry.hookScripts.filter((entry) => entry.target !== "hooks/compact.mjs");
      registry.plugin.name = "wf-two";
    });
    assertError(findings, /hookScripts must install hooks\/compact.mjs/);
    assertError(findings, /plugin.name wf-two renames the compact tool to mcp__wf-two__compact, but hooks\/compact.mjs serves mcp__wf__compact/);
  });

  test("requires the title hook in hookScripts", () => {
    const findings = lintWith((registry) => {
      registry.hookScripts = registry.hookScripts.filter((entry) => entry.target !== "hooks/title.mjs");
    });
    assertError(findings, /hookScripts must install hooks\/title.mjs/);
  });

  test("accepts the Concise output style in wfSettings and refuses an empty or non-string one (D114)", () => {
    assert.deepEqual(errors(lintWith((registry) => void (registry.wfSettings.outputStyle = "Concise"))), []);
    assert.deepEqual(errors(lintWith((registry) => void delete registry.wfSettings.outputStyle)), []);
    assertError(lintWith((registry) => void (registry.wfSettings.outputStyle = " ")), /wfSettings.outputStyle must name an output style such as Concise/);
    assertError(lintWith((registry) => void (registry.wfSettings.outputStyle = { name: "Concise" })), /wfSettings.outputStyle must name an output style/);
  });

  test("checks file targets, the needed hooks and the plugin name", () => {
    const findings = lintWith((registry) => {
      registry.hookScripts = registry.hookScripts.filter((entry) => entry.target !== "hooks/context.mjs");
      registry.scripts[0].target = "bin/wf-agents";
      registry.rules[0].target = "house.md";
      registry.plugin.name = "Claude Tools";
    });
    assertError(findings, /hookScripts must install hooks\/context.mjs/);
    assertError(findings, /scripts\[0\].target bin\/wf-agents must look like scripts\/<name>.mjs/);
    assertError(findings, /rules\[0\].target house.md must look like rules\/<name>.md/);
    assertError(findings, /plugin.name Claude Tools must be kebab-case/);
  });
});

describe("D106: the window is never redefined", () => {
  test("refuses autoCompactWindow anywhere in the registry", () => {
    assertError(
      lintWith((registry) => {
        registry.roles.coder.tiers.t1.autoCompactWindow = 850000;
      }),
      /roles.coder.tiers.t1.autoCompactWindow uses autoCompactWindow, which redefines the context window/
    );
  });

  test("refuses autoCompactWindow in wfSettings, also under modelSettings", () => {
    const findings = lintWith((registry) => {
      registry.wfSettings.autoCompactWindow = 850000;
      registry.wfSettings.modelSettings = { "claude-opus-5-5": { autoCompactWindow: 850000 } };
    });
    assertError(findings, /wfSettings.autoCompactWindow uses autoCompactWindow/);
    assertError(findings, /wfSettings.modelSettings.claude-opus-5-5.autoCompactWindow uses autoCompactWindow/);
  });

  test("refuses CLAUDE_CODE_AUTO_COMPACT_WINDOW in the launcher env and in wfSettings env", () => {
    const findings = lintWith((registry) => {
      registry.launcher.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "850000";
      registry.wfSettings.env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "850000" };
    });
    assertError(findings, /launcher.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW uses CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
    assertError(findings, /wfSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW uses CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  });

  test("refuses autoCompactWindow in personas, the worker block and skill files", () => {
    const root = copyFixture();
    fs.appendFileSync(path.join(root, "personas", "coder.md"), "\nSet autoCompactWindow to 850000.\n");
    fs.appendFileSync(path.join(root, "prompts", "worker.md"), "\nautoCompactWindow: 850000\n");
    fs.appendFileSync(path.join(root, "skills", "beta", "references", "guide.md"), "\nautoCompactWindow\n");
    const findings = lintSources(loadSources(root));
    assertError(findings, /line 5: autoCompactWindow redefines the context window/, "personas/coder.md");
    assertError(findings, /autoCompactWindow redefines/, "prompts/worker.md");
    assertError(findings, /autoCompactWindow redefines/, "skills/beta/references/guide.md");
  });

  test("refuses CLAUDE_CODE_AUTO_COMPACT_WINDOW in personas, the worker block and skill files", () => {
    const root = copyFixture();
    fs.appendFileSync(path.join(root, "personas", "coder.md"), "\nRun export CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000 first.\n");
    fs.appendFileSync(path.join(root, "prompts", "worker.md"), "\nCLAUDE_CODE_AUTO_COMPACT_WINDOW=400000\n");
    fs.appendFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "\nCLAUDE_CODE_AUTO_COMPACT_WINDOW\n");
    fs.appendFileSync(path.join(root, "skills", "beta", "references", "guide.md"), "\nCLAUDE_CODE_AUTO_COMPACT_WINDOW\n");
    const findings = lintSources(loadSources(root));
    assertError(findings, /line 5: CLAUDE_CODE_AUTO_COMPACT_WINDOW redefines the context window/, "personas/coder.md");
    assertError(findings, /CLAUDE_CODE_AUTO_COMPACT_WINDOW redefines/, "prompts/worker.md");
    assertError(findings, /CLAUDE_CODE_AUTO_COMPACT_WINDOW redefines/, "skills/alpha/SKILL.md");
    assertError(findings, /CLAUDE_CODE_AUTO_COMPACT_WINDOW redefines/, "skills/beta/references/guide.md");
  });
});

describe("texts and skills", () => {
  test("refuses unknown placeholders and skillDir outside skills, with line numbers", () => {
    const root = copyFixture();
    fs.writeFileSync(path.join(root, "personas", "docs.md"), "# Docs\n\n{{tiers}} and {{skillDir}}\n");
    fs.appendFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "\n{{nope}} and {{skillDir}}\n");
    const findings = lintSources(loadSources(root));
    assertError(findings, /line 3: unknown placeholder \{\{tiers\}\}/, "personas/docs.md");
    assertError(findings, /line 3: \{\{skillDir\}\} works only inside a skill body/, "personas/docs.md");
    assertError(findings, /line 13: unknown placeholder \{\{nope\}\}/, "skills/alpha/SKILL.md");
    assert.ok(!findings.some((item) => item.where === "skills/alpha/SKILL.md" && /works only inside a skill body/.test(item.message)), "skillDir is fine in a skill body");
  });

  test("ignores unknown placeholders in skill references", () => {
    const root = copyFixture();
    fs.appendFileSync(path.join(root, "skills", "beta", "references", "guide.md"), "\n{{anything}}\n");
    assert.deepEqual(lintSources(loadSources(root)), []);
  });

  test("refuses a placeholder typo in a skill reference that would ship unexpanded", () => {
    const root = copyFixture();
    fs.appendFileSync(path.join(root, "skills", "beta", "references", "guide.md"), "\nSee {{skilldir}}/x and {{ matrix.shard }}.\n");
    const findings = lintSources(loadSources(root));
    assertError(findings, /\{\{skilldir\}\} is not expanded; did you mean \{\{skillDir\}\}\?/, "skills/beta/references/guide.md");
    assert.equal(findings.filter((item) => item.level === "error").length, 1, JSON.stringify(findings));
  });

  test("accepts a plugin author and refuses one without a name", () => {
    assert.deepEqual(lintWith((registry) => {
      registry.plugin.author = { name: "Procisz" };
    }).filter((item) => item.level === "error"), []);
    assertError(lintWith((registry) => {
      registry.plugin.author = {};
    }), /plugin\.author\.name/);
  });

  test("refuses a persona with frontmatter and an empty worker block", () => {
    const root = copyFixture();
    fs.writeFileSync(path.join(root, "personas", "coder.md"), "---\nname: coder\n---\nBody\n");
    fs.writeFileSync(path.join(root, "prompts", "worker.md"), "\n");
    const findings = lintSources(loadSources(root));
    assertError(findings, /persona files are body text only/, "personas/coder.md");
    assertError(findings, /the worker block is empty/, "prompts/worker.md");
  });

  test("validates skill frontmatter", () => {
    const root = copyFixture();
    const file = path.join(root, "skills", "gamma", "SKILL.md");
    const text = fs.readFileSync(file, "utf8").replace("name: gamma", "name: gama").replace("    - coder", "    - writer");
    fs.writeFileSync(file, text);
    fs.mkdirSync(path.join(root, "skills", "delta"));
    const findings = lintSources(loadSources(root));
    assertError(findings, /frontmatter name "gama" differs from the folder name gamma/, "skills/gamma/SKILL.md");
    assertError(findings, /metadata.wf-default names unknown role writer/, "skills/gamma/SKILL.md");
    assertError(findings, /has no SKILL.md/, "skills/delta");
  });

  test("checks the compiled agents when the sources are clean", () => {
    const sources = loadSources(fixtureRoot);
    const broken = { ...sources, personas: { ...sources.personas } };
    broken.personas.coder = "Body with {{agentTable}} only";
    assert.deepEqual(lintSources(broken), []);
    const missing = { ...sources, hookScripts: sources.hookScripts.map((entry) => ({ ...entry, text: null })) };
    assertError(lintSources(missing), /compile: hook script hooks\/guard.mjs is missing/, "compile");
  });

  test("formatFindings prints one line per finding and a summary", () => {
    const findings = [
      { level: "error", where: "a.md", message: "bad" },
      { level: "warning", where: "b.md", message: "meh" }
    ];
    assert.deepEqual(formatFindings(findings), ["[error] a.md: bad", "[warning] b.md: meh", "lint: 1 error, 1 warning"]);
    assert.deepEqual(formatFindings([]), ["lint: 0 errors, 0 warnings"]);
    assert.deepEqual(countFindings(findings), { errors: 1, warnings: 1 });
  });
});

describe("findComments", () => {
  test("finds line and block comments", () => {
    const comments = findComments("const a = 1; // note\n/* block\n text */\nconst b = 2;\n");
    assert.deepEqual(
      comments.map((item) => [item.line, item.todo]),
      [
        [1, false],
        [2, false]
      ]
    );
  });

  test("marks TODO comments", () => {
    const comments = findComments("// TODO: later\n/* TODO tidy */\n/**\n * TODO doc\n */\n");
    assert.ok(comments.every((item) => item.todo), JSON.stringify(comments));
  });

  test("ignores comment markers inside strings, templates and regex literals", () => {
    const source = [
      'const url = "https://example.com/a";',
      "const single = 'a // b';",
      "const tpl = `x // ${'y /* z */'} w`;",
      "const re = /\\/\\/ not a comment/g;",
      "const cls = /[/*]/;",
      "if (/^\\/\\//.test(url)) run();",
      "const half = total / 2 / 3;",
      "const back = `${a}/${b}`;"
    ].join("\n");
    assert.deepEqual(findComments(source), []);
  });

  test("treats a slash after a value as division and after return as a regex", () => {
    assert.deepEqual(findComments("function f(x) { return /a\\/b/.test(x); }\nconst y = (x) / 2;"), []);
    assert.equal(findComments("const y = x / 2; // trailing").length, 1);
  });

  test("skips a shebang line", () => {
    assert.deepEqual(findComments("#!/usr/bin/env node\nconst a = 1;\n"), []);
  });
});

describe("lintSelf", () => {
  function repo(files) {
    const root = tempDir("wf-self-");
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return root;
  }

  test("finds nothing in clean files", () => {
    const root = repo({ "lib/a.mjs": "export const a = 1;\n", "README.md": "# Read me\n", "x.json": "{}\n" });
    assert.deepEqual(lintSelf(root), []);
  });

  test("refuses comments in .mjs and .js but allows TODO", () => {
    const root = repo({ "lib/a.mjs": "export const a = 1; // why\n// TODO later\n", "lib/b.js": "/* block */\n", "notes.md": "// fine in markdown\n" });
    const findings = lintSelf(root);
    assert.deepEqual(
      findings.map((item) => [item.where, item.message.slice(0, 20)]),
      [
        ["lib/a.mjs", "line 1: comment foun"],
        ["lib/b.js", "line 1: comment foun"]
      ]
    );
  });

  test("refuses U+2012 to U+2015 in every checked extension", () => {
    const files = {};
    for (const [index, ext] of [".md", ".mjs", ".js", ".json", ".yml", ".yaml", ".html", ".sh", ".cmd"].entries()) {
      files[`f${index}${ext}`] = `"x ${[EM, EN, FIGURE, BAR][index % 4]} y"\n`;
    }
    const findings = lintSelf(repo(files));
    assert.equal(findings.length, 9, JSON.stringify(findings));
    assert.ok(findings.every((item) => /line 1: forbidden character U\+201[2-5]; use a comma, a colon or a hyphen instead/.test(item.message)));
  });

  test("refuses a raw byte order mark inside a file, where no editor shows it", () => {
    const findings = lintSelf(repo({ "c.mjs": `export const x = /^${String.fromCodePoint(0xfeff)}/;\n`, "d.md": "fine \\uFEFF escape\n" }));
    assert.deepEqual(
      findings.map((item) => [item.where, item.message]),
      [["c.mjs", "line 1: a raw byte order mark (U+FEFF) inside the text; write it as the escape \\uFEFF"]]
    );
  });

  test("refuses CRLF and a byte order mark", () => {
    const findings = lintSelf(repo({ "a.md": "one\r\ntwo\r\n", "b.md": "\uFEFF# Title\n" }));
    assert.deepEqual(
      findings.map((item) => [item.where, item.message]),
      [
        ["a.md", "line 1: carriage return found; use LF line endings only"],
        ["b.md", "starts with a byte order mark; save it as UTF-8 without BOM"]
      ]
    );
  });

  test("skips .git, .work, node_modules and probe-output and other extensions", () => {
    const bad = `${EM}\n`;
    const root = repo({
      ".git/x.md": bad,
      ".work/task/x.md": bad,
      "node_modules/p/x.js": "// c\n",
      "probe-output/x.json": bad,
      "image.svg": bad,
      "ok.md": "fine\n"
    });
    assert.deepEqual(listSelfFiles(root), ["ok.md"]);
    assert.deepEqual(lintSelf(root), []);
  });

  test("lintText checks one file by its extension", () => {
    assert.equal(lintText("a.txt", "// x\n").length, 0);
    assert.equal(lintText("a.mjs", "// x\n").length, 1);
  });

  test("the compile builder's own files follow the house rules", () => {
    const repoRoot = path.dirname(here);
    const own = [
      "registry.json",
      "lib/skills.mjs",
      "lib/compile.mjs",
      "lib/select.mjs",
      "lib/prompt.mjs",
      "lib/lint.mjs",
      "test/skills.test.mjs",
      "test/compile.test.mjs",
      "test/select.test.mjs",
      "test/lint.test.mjs"
    ];
    const findings = own.flatMap((rel) => lintText(rel, fs.readFileSync(path.join(repoRoot, ...rel.split("/")))));
    const fixtures = lintSelf(fixtureRoot);
    assert.deepEqual([...findings, ...fixtures], []);
  });
});
