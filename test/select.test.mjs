import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "../lib/skills.mjs";
import { loadSources, normalizeRoles } from "../lib/compile.mjs";
import { createUi, stripAnsi, visibleLength } from "../lib/ui.mjs";
import {
  EVERYTHING_INSTALLED,
  LOCKED_ROLE_HINT,
  REQUIRED_HINT,
  ROLE_FALLBACKS,
  ROLE_SUMMARIES,
  SUMMARY_ACTIONS,
  TIER_SIZES,
  TIER_SUMMARIES,
  askChoices,
  askNext,
  askSkills,
  choiceLines,
  defaultChoices,
  defaultSelection,
  explanation,
  formatSelection,
  installModel,
  joinList,
  modelsAnswer,
  nearestTier,
  normalizeSaved,
  remapModel,
  renderSetupNotes,
  resolveChoices,
  resolveSelection,
  resolveSetup,
  resolveStart,
  roleItems,
  roleNoun,
  roleTitle,
  savedAnswer,
  savedChoices,
  setupNoteLines,
  setupSummaryLines,
  skillsAnswer,
  summaryLines,
  validateChoices
} from "../lib/select.mjs";
import { captureIo, scriptedSelections } from "./data/install/helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCES = loadSources(path.join(here, "data", "compile"));
const MODEL = installModel({ registry: SOURCES.registry, roles: SOURCES.roles });
const REAL_SOURCES = loadSources(path.join(here, ".."));
const REAL_MODEL = installModel({ registry: REAL_SOURCES.registry, roles: REAL_SOURCES.roles });
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const ORDER = [OPUS, SONNET, HAIKU];
const WORKERS = ["planner", "docs", "coder", "tester", "reviewer", "debugger", "git"];
const RICH = createUi({ rich: true, unicode: true, color: true, columns: 100 });

function skill(name, required = [], defaults = [], description = `${name} skill`) {
  return { name, description, required, defaults };
}

const SKILLS = [
  skill("discussion", ["orchestrator"]),
  skill("context-cache", [...ROLES]),
  skill("javascript", [], ["planner", "coder", "tester", "reviewer"]),
  skill("testing", ["tester"], ["coder"]),
  skill("seo", [], ["reviewer"]),
  skill("debugging", ["debugger"])
];

function empty() {
  return Object.fromEntries(ROLES.map((role) => [role, []]));
}

function reduced() {
  return { tiers: ["t1", "t2"], roles: ["planner", "docs", "coder", "tester"], models: [SONNET, HAIKU] };
}

describe("installModel", () => {
  test("reads the tiers from the role variants, the model order, the required roles and the labels", () => {
    assert.deepEqual(MODEL.tiers, ["t1", "t2", "t3"]);
    assert.deepEqual(MODEL.models, ORDER);
    assert.deepEqual(MODEL.required, ["coder"]);
    assert.equal(MODEL.main.name, "orchestrator");
    assert.deepEqual(MODEL.workers.map((role) => role.name), WORKERS);
    assert.equal(MODEL.labels[OPUS], "Opus 5.5");
    assert.equal(MODEL.plugin, "wf");
  });

  test("without an install section the models keep the registry order and nothing is locked", () => {
    const registry = { ...SOURCES.registry, install: undefined, models: { [HAIKU]: { label: "Haiku" }, [OPUS]: { label: "Opus" } } };
    const model = installModel({ registry, roles: SOURCES.roles });
    assert.deepEqual(model.models.slice(0, 2), [HAIKU, OPUS], "registry key order first, then models only the roles name");
    assert.ok(model.models.includes(SONNET));
    assert.deepEqual(model.required, []);
  });

  test("ignores unknown models and required roles that are not workers", () => {
    const registry = { ...SOURCES.registry, install: { models: ["claude-nope-1", HAIKU], requiredRoles: ["orchestrator", "ghost", "tester"] } };
    const model = installModel({ registry, roles: normalizeRoles(registry) });
    assert.equal(model.models[0], HAIKU);
    assert.ok(!model.models.includes("claude-nope-1"));
    assert.deepEqual(model.required, ["tester"]);
  });
});

describe("choices", () => {
  test("the defaults tick every tier, worker role and model", () => {
    assert.deepEqual(defaultChoices(MODEL), { tiers: ["t1", "t2", "t3"], roles: WORKERS, models: ORDER });
  });

  test("resolveChoices keeps a saved answer and falls back to the defaults", () => {
    const saved = savedChoices(reduced(), MODEL);
    assert.deepEqual(resolveChoices({ model: MODEL, saved }), reduced());
    assert.deepEqual(resolveChoices({ model: MODEL, saved, reset: true }), defaultChoices(MODEL));
    assert.deepEqual(resolveChoices({ model: MODEL, saved: null }), defaultChoices(MODEL));
    assert.deepEqual(resolveChoices({ model: MODEL, saved: "nonsense" }), defaultChoices(MODEL));
    assert.deepEqual(resolveChoices({ model: MODEL, saved: { tiers: "t1" } }), defaultChoices(MODEL), "a kind that is not a list gets its default");
  });

  test("a tier, role or model added since the saved answer starts ticked", () => {
    const saved = { tiers: ["t1"], roles: ["coder"], models: [HAIKU], known: { tiers: ["t1", "t2"], roles: ["coder", "docs"], models: [SONNET, HAIKU] } };
    assert.deepEqual(resolveChoices({ model: MODEL, saved }), { tiers: ["t1", "t3"], roles: ["planner", "coder", "tester", "reviewer", "debugger", "git"], models: [OPUS, HAIKU] });
  });

  test("the coder stays chosen even when the saved answer leaves it out", () => {
    const saved = savedChoices({ tiers: ["t1"], roles: [], models: [HAIKU] }, MODEL);
    assert.deepEqual(resolveChoices({ model: MODEL, saved }).roles, ["coder"]);
  });

  test("an empty tier or model answer falls back to all of them", () => {
    const saved = savedChoices({ tiers: [], roles: WORKERS, models: [] }, MODEL);
    const result = resolveChoices({ model: MODEL, saved });
    assert.deepEqual(result.tiers, MODEL.tiers);
    assert.deepEqual(result.models, MODEL.models);
  });

  test("savedChoices records the answers and the items known now", () => {
    assert.deepEqual(savedChoices(reduced(), MODEL), { ...reduced(), known: { tiers: ["t1", "t2", "t3"], roles: WORKERS, models: ORDER } });
  });

  test("resolveStart combines the saved choices and the saved skills, and reset drops both", () => {
    const saved = { choices: savedChoices(reduced(), MODEL), skills: savedAnswer({ ...defaultSelection(SKILLS), coder: ["context-cache"] }, SKILLS) };
    const start = resolveStart({ model: MODEL, skills: SKILLS, saved });
    assert.deepEqual(start.tiers, ["t1", "t2"]);
    assert.deepEqual(start.skills.coder, ["context-cache"]);
    const reset = resolveStart({ model: MODEL, skills: SKILLS, saved, reset: true });
    assert.deepEqual(reset.tiers, MODEL.tiers);
    assert.deepEqual(reset.skills, defaultSelection(SKILLS));
  });

  test("validateChoices refuses unknown ids and empty tiers or models", () => {
    assert.doesNotThrow(() => validateChoices(MODEL, reduced()));
    assert.throws(() => validateChoices(MODEL, { ...reduced(), tiers: ["t9"] }), /choices.tiers names unknown tier t9/);
    assert.throws(() => validateChoices(MODEL, { ...reduced(), roles: ["orchestrator"] }), /choices.roles names unknown role orchestrator/);
    assert.throws(() => validateChoices(MODEL, { ...reduced(), models: ["claude-x"] }), /choices.models names unknown model claude-x/);
    assert.throws(() => validateChoices(MODEL, { ...reduced(), tiers: [] }), /at least one tier/);
    assert.throws(() => validateChoices(MODEL, { ...reduced(), models: [] }), /at least one model/);
    assert.throws(() => validateChoices(MODEL, { ...reduced(), roles: "coder" }), /choices.roles must be a list/);
    assert.throws(() => validateChoices(MODEL, null), /choices must be an object/);
  });
});

describe("nearest tier and model", () => {
  const tiers = ["t1", "t2", "t3"];
  const cases = [
    ["t2", ["t1", "t3"], "t3", "a tie goes to the higher tier"],
    ["t2", ["t1"], "t1", "only a lower tier is left"],
    ["t3", ["t1", "t2"], "t2", "the nearest lower tier"],
    ["t3", ["t1"], "t1", "two steps down"],
    ["t1", ["t2", "t3"], "t2", "the nearest higher tier"],
    ["t1", ["t3"], "t3", "two steps up"],
    ["t2", ["t2"], "t2", "an installed tier runs as itself"],
    ["t2", [], null, "nothing installed"]
  ];
  for (const [tier, installed, want, why] of cases) {
    test(`nearestTier ${tier} with ${installed.join(", ") || "none"} is ${want}: ${why}`, () => assert.equal(nearestTier(tier, installed, tiers), want));
  }

  const fourTiers = ["t1", "t2", "t3", "t4"];
  const fourCases = [
    ["t4", ["t1", "t2", "t3"], "t3", "a missing T4 runs as T3"],
    ["t4", ["t1", "t2"], "t2", "T4 and T3 missing: T2"],
    ["t3", ["t2", "t4"], "t4", "a missing T3 runs as T4 on a tie"],
    ["t3", ["t1", "t2"], "t2", "a missing T3 runs as T2 when T4 is missing too"],
    ["t2", ["t1", "t4"], "t1", "T2 is nearer to T1 than to T4"],
    ["t3", ["t1", "t4"], "t4", "T3 is nearer to T4 than to T1"],
    ["t2", ["t1"], "t1", "only T1 is left"],
    ["t3", ["t1"], "t1", "only T1 is left"],
    ["t4", ["t1"], "t1", "only T1 is left"],
    ["t4", ["t4"], "t4", "an installed T4 runs as itself"]
  ];
  for (const [tier, installed, want, why] of fourCases) {
    test(`nearestTier ${tier} of four tiers with ${installed.join(", ")} is ${want}: ${why}`, () => assert.equal(nearestTier(tier, installed, fourTiers), want));
  }

  const fiveTiers = ["t1", "t2", "t3", "t4", "t5"];
  const fiveCases = [
    ["t5", ["t1", "t2", "t3", "t4"], "t4", "a missing T5 runs as T4"],
    ["t4", ["t1", "t3", "t5"], "t5", "a missing T4 runs as T5 on a tie"],
    ["t3", ["t1", "t5"], "t5", "a missing T3 runs as T5 on a tie"],
    ["t5", ["t1"], "t1", "only T1 is left"],
    ["t5", ["t5"], "t5", "an installed T5 runs as itself"]
  ];
  for (const [tier, installed, want, why] of fiveCases) {
    test(`nearestTier ${tier} of five tiers with ${installed.join(", ")} is ${want}: ${why}`, () => assert.equal(nearestTier(tier, installed, fiveTiers), want));
  }

  const models = [
    [SONNET, [OPUS, HAIKU], OPUS, "a tie goes to the stronger model"],
    [OPUS, [SONNET, HAIKU], SONNET, "the nearest weaker model"],
    [OPUS, [HAIKU], HAIKU, "two steps down"],
    [HAIKU, [OPUS, SONNET], SONNET, "the nearest stronger model"],
    [HAIKU, [OPUS], OPUS, "two steps up"],
    [SONNET, [SONNET], SONNET, "a ticked model stays"],
    ["claude-other", [HAIKU], "claude-other", "a model outside the order stays"]
  ];
  for (const [model, allowed, want, why] of models) {
    test(`remapModel ${model} with ${allowed.join(", ")} is ${want}: ${why}`, () => assert.equal(remapModel(model, allowed, ORDER), want));
  }
});

describe("resolveSetup", () => {
  test("the defaults install all 20 agents with nothing missing", () => {
    const setup = resolveSetup(MODEL, defaultChoices(MODEL));
    assert.equal(setup.complete, true);
    assert.equal(setup.variants.length, 20);
    assert.deepEqual(setup.missingTiers, []);
    assert.deepEqual(setup.missingRoles, []);
    assert.deepEqual(setup.remaps, []);
    assert.deepEqual(setup.variants[0], { role: "orchestrator", agent: "orchestrator", tier: null, model: OPUS, effort: "medium" });
  });

  test("the coder is locked: it is installed even when no role is chosen", () => {
    const setup = resolveSetup(MODEL, { tiers: ["t1", "t2", "t3"], roles: [], models: ORDER });
    assert.deepEqual(setup.roles.filter((role) => role.status === "installed").map((role) => role.name), ["orchestrator", "coder"]);
    assert.deepEqual(setup.missingRoles, ["planner", "docs", "tester", "reviewer", "debugger", "git"]);
    assert.equal(setup.roles.find((role) => role.name === "coder").required, true);
  });

  test("with T1 alone the planner runs as planner-t1 and the git agent is still installed (D112, D115)", () => {
    const setup = resolveSetup(MODEL, { tiers: ["t1"], roles: WORKERS, models: ORDER });
    assert.equal(setup.roles.find((role) => role.name === "planner").status, "installed");
    assert.deepEqual(setup.missingRoles, []);
    assert.deepEqual(setup.variants.filter((variant) => variant.role === "planner").map((variant) => variant.agent), ["planner-t1"]);
    assert.deepEqual(setup.variants.find((variant) => variant.role === "git"), { role: "git", agent: "git", tier: null, model: SONNET, effort: "medium" });
    assert.deepEqual(setup.missingTiers, [
      { tier: "t2", runsAs: "t1" },
      { tier: "t3", runsAs: "t1" }
    ]);
  });

  test("a reduced setup keeps only the chosen variants and moves unticked models", () => {
    const setup = resolveSetup(MODEL, reduced());
    assert.deepEqual(
      setup.variants.map((variant) => `${variant.agent} ${variant.model}${variant.remappedFrom ? ` from ${variant.remappedFrom}` : ""}`),
      [
        `orchestrator ${SONNET} from ${OPUS}`,
        `planner-t1 ${HAIKU}`,
        `planner-t2 ${SONNET}`,
        `docs-t1 ${HAIKU}`,
        `docs-t2 ${HAIKU}`,
        `coder-t1 ${HAIKU}`,
        `coder-t2 ${SONNET}`,
        `tester-t1 ${HAIKU}`,
        `tester-t2 ${SONNET}`
      ]
    );
    assert.deepEqual(setup.missingTiers, [{ tier: "t3", runsAs: "t2" }]);
    assert.deepEqual(setup.missingRoles, ["reviewer", "debugger", "git"]);
    assert.deepEqual(setup.remaps, [{ from: OPUS, to: SONNET, agents: ["orchestrator"] }]);
    assert.equal(setup.complete, false);
    assert.equal(setup.variants.find((variant) => variant.agent === "orchestrator").effort, "medium", "the effort stays");
  });

  test("an unticked Sonnet moves its agents up to Opus on a tie and groups the remaps per model", () => {
    const setup = resolveSetup(MODEL, { tiers: ["t2"], roles: WORKERS, models: [OPUS, HAIKU] });
    assert.deepEqual(setup.remaps, [{ from: SONNET, to: OPUS, agents: ["planner-t2", "coder-t2", "tester-t2", "reviewer-t2", "git"] }]);
    assert.ok(setup.variants.filter((variant) => variant.remappedFrom).every((variant) => variant.model === OPUS));
  });

  test("the git agent needs any tier and is unused only when no tier is chosen", () => {
    const git = MODEL.workers.find((role) => role.name === "git");
    for (const tiers of [["t1"], ["t2"], ["t3"], ["t1", "t3"]]) {
      const setup = resolveSetup(MODEL, { tiers, roles: ["coder", "git"], models: ORDER });
      assert.deepEqual(setup.variants.filter((variant) => variant.role === "git").map((variant) => variant.agent), ["git"], `tiers ${tiers}`);
    }
    const without = resolveSetup(MODEL, { tiers: ["t2"], roles: ["coder"], models: ORDER });
    assert.equal(without.roles.find((role) => role.name === "git").status, "missing");
    assert.ok(without.missingRoles.includes("git"));
    assert.equal(git.single, true);
  });

  test("a model nobody installed uses makes no remap", () => {
    const setup = resolveSetup(MODEL, { tiers: ["t2"], roles: ["coder"], models: [OPUS, SONNET] });
    assert.deepEqual(setup.remaps, [], "no t2 coder or orchestrator is set to Haiku");
  });
});

describe("setup notes", () => {
  test("a full install says everything is installed", () => {
    const setup = resolveSetup(MODEL, defaultChoices(MODEL));
    assert.equal(renderSetupNotes(setup, MODEL), EVERYTHING_INSTALLED);
    assert.deepEqual(setupSummaryLines(setup, MODEL), []);
  });

  test("one orchestrator line per missing tier, missing role and moved model", () => {
    const setup = resolveSetup(MODEL, reduced());
    assert.deepEqual(setupNoteLines(setup, MODEL), [
      "Tier T3 is not installed: run a T3-sized task as T2 and say so in the summary.",
      ROLE_FALLBACKS.reviewer.agent,
      ROLE_FALLBACKS.debugger.agent,
      ROLE_FALLBACKS.git.agent,
      "Model Opus 5.5 is not installed: wf:orchestrator runs on Sonnet 5.5 with its effort unchanged."
    ]);
    assert.equal(renderSetupNotes(setup, MODEL), setupNoteLines(setup, MODEL).map((line) => `- ${line}`).join("\n"));
  });

  test("every optional role has a fallback rule and the texts follow D109, D110, D112 and D115", () => {
    assert.equal(ROLE_FALLBACKS.planner.agent, "The planner is not installed: a coder of the task's tier writes plan.md in a plan-only round before implementation.");
    assert.match(ROLE_FALLBACKS.docs.agent, /the coder does the docs steps of plan\.md in its package/);
    assert.match(ROLE_FALLBACKS.tester.agent, /the coder writes and runs the tests after its code/);
    assert.equal(ROLE_FALLBACKS.reviewer.agent, "The reviewer is not installed: when the user asks for a review, a coder of the task's tier does a separate read-only review round with the code-review skill.");
    assert.equal(ROLE_FALLBACKS.git.agent, "The git agent is not installed: leave the work uncommitted and list the git commands in the report.");
    for (const name of ["planner", "reviewer", "git"]) assert.doesNotMatch(ROLE_FALLBACKS[name].user, /orchestrator/, `${name}: with subagents the orchestrator only delegates (D112)`);
    assert.equal(ROLE_FALLBACKS.debugger.agent, "The debugger is not installed: a failure that comes back for the same reason gets one more coder fix round when the phase's cap allows; when that round does not clear it, it goes to the report.");
    assert.equal(ROLE_FALLBACKS.debugger.user, "a repeated failure gets one more coder round, then the report");
    for (const role of MODEL.workers.filter((entry) => !MODEL.required.includes(entry.name))) {
      assert.ok(ROLE_FALLBACKS[role.name]?.agent && ROLE_FALLBACKS[role.name]?.user, `${role.name} has a fallback for the orchestrator and for the user`);
      assert.ok(ROLE_SUMMARIES[role.name], `${role.name} has a summary`);
    }
    for (const [name, fallback] of Object.entries(ROLE_FALLBACKS)) assert.match(fallback.agent, /^The [a-z ]+ is not installed: /, `${name}: every orchestrator note starts the same way`);
    for (const [name, fallback] of Object.entries(ROLE_FALLBACKS)) assert.ok(fallback.agent.startsWith(`${roleNoun(name, { capital: true })} is not installed: `), `${name}: the note names the role as roleNoun does`);
    const setup = resolveSetup(MODEL, { tiers: ["t3"], roles: [], models: [HAIKU] });
    const lines = setupNoteLines(setup, MODEL);
    assert.deepEqual(lines.slice(0, 2), ["Tier T1 is not installed: run a T1-sized task as T3 and say so in the summary.", "Tier T2 is not installed: run a T2-sized task as T3 and say so in the summary."]);
    assert.deepEqual(lines.slice(2, 8), ["planner", "docs", "tester", "reviewer", "debugger", "git"].map((name) => ROLE_FALLBACKS[name].agent));
    assert.match(lines[8], /^Model Opus 5\.5 is not installed: wf:orchestrator run/);
    assert.match(lines[9], /^Model Sonnet 5\.5 is not installed: wf:coder-t3 runs on Haiku 5\.5 with its effort unchanged\.$/);
    assert.equal(lines.length, 10);
  });

  test("the user-facing summary lines name the fallback in plain words", () => {
    assert.deepEqual(setupSummaryLines(resolveSetup(MODEL, reduced()), MODEL), [
      "T3 not installed: a T3-sized task runs as T2",
      "reviewer not installed: a coder of the tier reviews in a separate read-only round when asked",
      "debugger not installed: a repeated failure gets one more coder round, then the report",
      "git not installed: the work stays uncommitted and the report lists the git commands",
      "Opus 5.5 not installed: orchestrator runs on Sonnet 5.5"
    ]);
  });

  test("joinList", () => {
    assert.equal(joinList([]), "");
    assert.equal(joinList(["a"]), "a");
    assert.equal(joinList(["a", "b"]), "a and b");
    assert.equal(joinList(["a", "b", "c"]), "a, b and c");
  });
});

describe("skills selection", () => {
  test("ticks required and default skills per role, in skill order", () => {
    assert.deepEqual(defaultSelection(SKILLS), {
      orchestrator: ["discussion", "context-cache"],
      planner: ["context-cache", "javascript"],
      docs: ["context-cache"],
      coder: ["context-cache", "javascript", "testing"],
      tester: ["context-cache", "javascript", "testing"],
      reviewer: ["context-cache", "javascript", "seo"],
      debugger: ["context-cache", "debugging"],
      git: ["context-cache"]
    });
    assert.deepEqual(defaultSelection([]), empty());
    assert.deepEqual(defaultSelection(undefined), empty());
  });

  test("gives the defaults with no saved answer or with reset", () => {
    const defaults = defaultSelection(SKILLS);
    assert.deepEqual(resolveSelection({ skills: SKILLS }), defaults);
    assert.deepEqual(resolveSelection({ skills: SKILLS, saved: "nonsense" }), defaults);
    const saved = savedAnswer({ ...empty(), reviewer: ["context-cache"] }, SKILLS);
    assert.deepEqual(resolveSelection({ skills: SKILLS, saved, reset: true }), defaults);
  });

  test("keeps a saved answer, including unticked defaults, and always keeps required skills", () => {
    const saved = savedAnswer({ ...defaultSelection(SKILLS), reviewer: ["context-cache"], docs: ["context-cache", "javascript"] }, SKILLS);
    const result = resolveSelection({ skills: SKILLS, saved });
    assert.deepEqual(result.reviewer, ["context-cache"]);
    assert.deepEqual(result.docs, ["context-cache", "javascript"]);
    const bare = resolveSelection({ skills: SKILLS, saved: savedAnswer(empty(), SKILLS) });
    assert.deepEqual(bare.tester, ["context-cache", "testing"]);
  });

  test("gives skills added since the saved answer their defaults and drops skills that are gone", () => {
    const older = SKILLS.filter((item) => item.name !== "seo");
    const saved = savedAnswer({ ...defaultSelection(older), reviewer: ["context-cache"] }, older);
    assert.deepEqual(resolveSelection({ skills: SKILLS, saved }).reviewer, ["context-cache", "seo"], "seo is new, so it gets its reviewer default; javascript stays unticked");
    const gone = savedAnswer({ ...defaultSelection(SKILLS), coder: ["javascript", "gone"] }, [...SKILLS, skill("gone")]);
    assert.deepEqual(resolveSelection({ skills: SKILLS, saved: gone }).coder, ["context-cache", "javascript"]);
  });

  test("accepts a plain selection and the manifest record { known, selection }", () => {
    const plain = { ...defaultSelection(SKILLS), coder: ["context-cache"] };
    assert.deepEqual(resolveSelection({ skills: SKILLS, saved: plain }).coder, ["context-cache"]);
    const older = SKILLS.filter((item) => item.name !== "seo");
    const record = { known: older.map((item) => item.name), selection: { ...defaultSelection(older), reviewer: ["context-cache"] } };
    assert.deepEqual(resolveSelection({ skills: SKILLS, saved: record }).reviewer, ["context-cache", "seo"]);
  });

  test("normalizeSaved reads the manifest shape, its skills alias and a plain selection", () => {
    assert.equal(normalizeSaved(null), null);
    const wrapped = normalizeSaved({ selection: { coder: ["a"] }, known: ["a", "b"] });
    assert.deepEqual(wrapped.lists, { coder: ["a"] });
    assert.deepEqual([...wrapped.known], ["a", "b"]);
    assert.deepEqual([...normalizeSaved({ selection: { coder: ["a"] }, skills: ["a", "c"] }).known], ["a", "c"]);
    const plain = normalizeSaved({ coder: ["a"], tester: ["c", 3] });
    assert.deepEqual(plain.lists, { coder: ["a"], tester: ["c"] });
  });

  test("roleItems locks required skills and uses the description as the hint of the others", () => {
    assert.deepEqual(
      roleItems(SKILLS, "coder", ["javascript"]).map((item) => [item.value, item.checked, item.locked, item.hint]),
      [
        ["discussion", false, false, "discussion skill"],
        ["context-cache", true, true, REQUIRED_HINT],
        ["javascript", true, false, "javascript skill"],
        ["testing", false, false, "testing skill"],
        ["seo", false, false, "seo skill"],
        ["debugging", false, false, "debugging skill"]
      ]
    );
    assert.equal(roleTitle("coder"), "Skills for the coder");
  });

  test("formatSelection prints one line per role", () => {
    assert.deepEqual(formatSelection({ ...empty(), coder: ["a", "b"] }, ["coder", "tester"]), ["coder: a, b", "tester: none"]);
    assert.equal(formatSelection(empty()).length, ROLES.length);
  });
});

describe("askSkills", () => {
  test("asks one list per given role with the role summary as help and keeps the other roles", async () => {
    const io = captureIo({ selections: scriptedSelections([["discussion", "seo"], () => []]) });
    const start = defaultSelection(SKILLS);
    const result = await askSkills({ skills: SKILLS, start, roles: ["orchestrator", "reviewer"], io });
    assert.deepEqual(io.calls.map((call) => [call.title, call.help]), [
      ["Skills for the orchestrator", ROLE_SUMMARIES.orchestrator],
      ["Skills for the reviewer", ROLE_SUMMARIES.reviewer]
    ]);
    assert.deepEqual(result.orchestrator, ["discussion", "context-cache", "seo"]);
    assert.deepEqual(result.reviewer, ["context-cache"], "a required skill stays when the answer leaves it out");
    assert.deepEqual(result.coder, start.coder, "a role that was not asked keeps its start answer");
    assert.deepEqual(io.lines, ["orchestrator: 3 skills", "reviewer: 1 skill"]);
  });

  test("returns null when a list is cancelled", async () => {
    const io = captureIo({ selections: () => null });
    assert.equal(await askSkills({ skills: SKILLS, start: defaultSelection(SKILLS), roles: ["coder"], io }), null);
  });
});

describe("askChoices", () => {
  function start(overrides = {}) {
    return { ...defaultChoices(MODEL), skills: defaultSelection(SOURCES.skills), ...overrides };
  }

  test("runs tiers, agents, models, then one skills list per installed role, with step headers and results", async () => {
    const io = captureIo({ selections: scriptedSelections([["t1", "t2"], ["planner", "docs", "coder", "tester"], [SONNET, HAIKU]]) });
    const result = await askChoices({ model: MODEL, skills: SOURCES.skills, start: start(), io });
    assert.deepEqual(
      io.calls.map((call) => call.title),
      ["Which tiers should wf install?", "Which agents should wf install?", "Which models should wf use?", ...["orchestrator", "planner", "docs", "coder", "tester"].map(roleTitle)]
    );
    assert.deepEqual({ tiers: result.tiers, roles: result.roles, models: result.models }, reduced());
    assert.deepEqual(result.skills, defaultSelection(SOURCES.skills));
    const text = io.text();
    for (const [number, title] of [[1, "Tiers"], [2, "Agents"], [3, "Models"], [4, "Skills"]]) assert.ok(text.includes(`Step ${number} of 5: ${title}`), `step ${number} header`);
    assert.ok(text.includes("Tiers: T1, T2 (T3 runs as T2)"), text);
    assert.ok(text.includes("Agents: planner, docs, coder, tester (without reviewer, debugger and git)"), text);
    assert.ok(text.includes("Models: Sonnet 5.5, Haiku 5.5 (1 agent on a stand-in)"), text);
    for (const key of ["tiers", "agents", "models", "skills"]) {
      const lines = explanation(key, MODEL);
      assert.ok(lines.length >= 2 && lines.length <= 4, `${key} explains in 2 to 4 lines`);
      for (const line of lines) assert.ok(text.includes(`  ${line}`), `${key}: ${line}`);
    }
  });

  test("asks at least one tier and one model, and starts each list from the start answers", async () => {
    const io = captureIo();
    await askChoices({ model: MODEL, skills: SOURCES.skills, start: start(reduced()), io });
    const [tiers, agents, models] = io.calls;
    assert.equal(tiers.min, 1);
    assert.equal(models.min, 1);
    assert.deepEqual(tiers.items.map((item) => [item.value, item.checked]), [["t1", true], ["t2", true], ["t3", false]]);
    assert.deepEqual(agents.items.map((item) => [item.value, item.checked]), [["planner", true], ["docs", true], ["coder", true], ["tester", true], ["reviewer", false], ["debugger", false], ["git", false]]);
    assert.deepEqual(models.items.map((item) => [item.label, item.checked]), [["Opus 5.5", false], ["Sonnet 5.5", true], ["Haiku 5.5", true]]);
  });

  test("the coder is locked with its reason, and with T1 alone every agent is shown, the planner and the git agent included", async () => {
    const io = captureIo({ selections: scriptedSelections([["t1"]]) });
    const result = await askChoices({ model: MODEL, skills: SOURCES.skills, start: start(), io });
    const agents = io.calls[1].items;
    assert.deepEqual(agents.map((item) => item.value), WORKERS);
    const coder = agents.find((item) => item.value === "coder");
    assert.equal(coder.locked, true);
    assert.equal(coder.hint, LOCKED_ROLE_HINT);
    const planner = agents.find((item) => item.value === "planner");
    assert.equal(planner.checked, true);
    assert.equal(planner.hint, "writes the execution plan of every task");
    assert.ok(result.roles.includes("planner"));
    assert.ok(io.calls.some((call) => call.title === roleTitle("planner")), "planner-t1 is installed, so the planner gets its skills list");
  });

  test("a role with no variant on the chosen tiers is hidden and keeps its start answer, ticked or not", async () => {
    const registry = JSON.parse(JSON.stringify(SOURCES.registry));
    delete registry.roles.planner.tiers.t1;
    const model = installModel({ registry, roles: normalizeRoles(registry) });
    const ticked = captureIo({ selections: scriptedSelections([["t1"]]) });
    const kept = await askChoices({ model, skills: SOURCES.skills, start: start(), io: ticked });
    assert.ok(!ticked.calls[1].items.some((item) => item.value === "planner"), "a planner without T1 is hidden at T1");
    assert.ok(kept.roles.includes("planner"), "the hidden planner keeps its start answer for a later install with T2");
    assert.ok(!ticked.calls.some((call) => call.title === roleTitle("planner")), "no skills list for an agent that is not installed");
    const unticked = await askChoices({ model, skills: SOURCES.skills, start: start({ roles: ["coder", "docs"] }), io: captureIo({ selections: scriptedSelections([["t1"]]) }) });
    assert.ok(!unticked.roles.includes("planner"));
  });

  test("the detail lines explain what unticking does, with the current ticks", async () => {
    const io = captureIo();
    await askChoices({ model: MODEL, skills: SOURCES.skills, start: start(), io });
    const [tiers, agents, models] = io.calls;
    const t3 = tiers.items.find((item) => item.value === "t3");
    assert.equal(t3.detail(["t1", "t2", "t3"]), "Untick T3: a T3-sized task would run as T2");
    assert.equal(t3.detail(["t1", "t2"]), "T3 is skipped: a T3-sized task runs as T2");
    assert.equal(t3.detail(["t3"]), "At least one tier is needed");
    assert.equal(t3.detail([]), "Tick at least one tier");
    const reviewer = agents.items.find((item) => item.value === "reviewer");
    assert.equal(reviewer.detail(["reviewer"]), `Untick the reviewer: ${ROLE_FALLBACKS.reviewer.user}`);
    assert.equal(reviewer.detail([]), `Without the reviewer: ${ROLE_FALLBACKS.reviewer.user}`);
    const gitItem = agents.items.find((item) => item.value === "git");
    assert.equal(gitItem.hint, "branches, commits, pushes and opens pull requests when the summary asks");
    assert.equal(gitItem.detail(["git"]), "Untick the git agent: the work stays uncommitted and the report lists the git commands");
    assert.equal(gitItem.detail([]), "Without the git agent: the work stays uncommitted and the report lists the git commands");
    const debuggerItem = agents.items.find((item) => item.value === "debugger");
    assert.equal(debuggerItem.hint, "fixes a failure that came back for the same reason");
    assert.equal(debuggerItem.detail(["debugger"]), "Untick the debugger: a repeated failure gets one more coder round, then the report");
    assert.equal(debuggerItem.detail([]), "Without the debugger: a repeated failure gets one more coder round, then the report");
    const opus = models.items.find((item) => item.value === OPUS);
    assert.equal(opus.hint, "set for 5 agents", "the orchestrator, planner-t3, reviewer-t3, debugger-t2 and debugger-t3");
    assert.equal(opus.detail(ORDER), "Untick Opus 5.5: its 5 agents would run on Sonnet 5.5");
    assert.equal(opus.detail([HAIKU]), "Opus 5.5 is off: its 5 agents run on Haiku 5.5");
    assert.equal(opus.detail([OPUS]), "At least one model is needed");
  });

  test("returns null when any list is cancelled", async () => {
    for (let at = 0; at < 4; at += 1) {
      const answers = [undefined, undefined, undefined, undefined];
      answers[at] = () => null;
      const io = captureIo({ selections: scriptedSelections(answers) });
      assert.equal(await askChoices({ model: MODEL, skills: SOURCES.skills, start: start(), io }), null, `cancel at list ${at + 1}`);
    }
  });

  test("needs io.multiSelect", async () => {
    await assert.rejects(askChoices({ model: MODEL, skills: SOURCES.skills, start: start(), io: { print() {} } }), /needs io.multiSelect/);
  });

  test("a rich terminal shows the step icons, colors and check marks", async () => {
    const io = captureIo({ selections: scriptedSelections([["t1", "t2"]]) });
    await askChoices({ model: MODEL, skills: SOURCES.skills, start: start(), io, ui: RICH });
    const text = io.text();
    assert.ok(text.includes("\u001b["), "colored");
    assert.ok(stripAnsi(text).includes("Step 1 of 5  \u{1F4CA} Tiers"), stripAnsi(text));
    assert.ok(stripAnsi(text).includes("  \u2714 Tiers: T1, T2 (T3 runs as T2)"));
  });
});

describe("summary", () => {
  function reducedChoices() {
    return { ...reduced(), skills: defaultSelection(SOURCES.skills) };
  }

  test("summaryLines shows the agent table with remap marks, the missing parts and the skills per role", () => {
    const choices = reducedChoices();
    const lines = summaryLines({ setup: resolveSetup(MODEL, choices), model: MODEL, choices });
    assert.deepEqual(lines.slice(0, 3), ["Step 5 of 5: Summary", ...explanation("summary", MODEL).map((line) => `  ${line}`)]);
    const table = lines.slice(3, 14);
    assert.deepEqual(table, [
      "  Role          Tier  Agent            Model        Effort",
      "  orchestrator  main  wf:orchestrator  Sonnet 5.5*  medium",
      "  planner       T1    wf:planner-t1    Haiku 5.5    high",
      "                T2    wf:planner-t2    Sonnet 5.5   high",
      "  docs          T1    wf:docs-t1       Haiku 5.5    medium",
      "                T2    wf:docs-t2       Haiku 5.5    medium",
      "  coder         T1    wf:coder-t1      Haiku 5.5    medium",
      "                T2    wf:coder-t2      Sonnet 5.5   medium",
      "  tester        T1    wf:tester-t1     Haiku 5.5    medium",
      "                T2    wf:tester-t2     Sonnet 5.5   medium",
      "  * runs on a stand-in: its set model is not installed"
    ]);
    assert.deepEqual(lines.slice(14), [
      "  note: T3 not installed: a T3-sized task runs as T2",
      "  note: reviewer not installed: a coder of the tier reviews in a separate read-only round when asked",
      "  note: debugger not installed: a repeated failure gets one more coder round, then the report",
      "  note: git not installed: the work stays uncommitted and the report lists the git commands",
      "  note: Opus 5.5 not installed: orchestrator runs on Sonnet 5.5",
      "  Skills: orchestrator 1, planner 0, docs 0, coder 2, tester 2"
    ]);
  });

  test("a full setup says everything is installed and has no remap legend", () => {
    const choices = { ...defaultChoices(MODEL), skills: defaultSelection(SOURCES.skills) };
    const lines = summaryLines({ setup: resolveSetup(MODEL, choices), model: MODEL, choices });
    assert.ok(lines.includes("Every tier, agent and model is installed."));
    assert.ok(!lines.some((line) => line.includes("stand-in")));
  });

  test("choiceLines lists the answers for a run without questions", () => {
    const choices = reducedChoices();
    assert.deepEqual(choiceLines({ setup: resolveSetup(MODEL, choices), model: MODEL, choices }), [
      "Tiers: T1, T2",
      "Agents: planner, docs, coder, tester",
      "Models: Sonnet 5.5, Haiku 5.5",
      "Skills: orchestrator 1, planner 0, docs 0, coder 2, tester 2",
      "note: T3 not installed: a T3-sized task runs as T2",
      "note: reviewer not installed: a coder of the tier reviews in a separate read-only round when asked",
      "note: debugger not installed: a repeated failure gets one more coder round, then the report",
      "note: git not installed: the work stays uncommitted and the report lists the git commands",
      "note: Opus 5.5 not installed: orchestrator runs on Sonnet 5.5"
    ]);
  });

  test("askNext offers Install, Change choices and Cancel and maps the answer", async () => {
    for (const [answer, want] of [["install", "install"], ["change", "change"], ["cancel", "cancel"], [null, "cancel"]]) {
      const io = captureIo({ choices: () => answer });
      assert.equal(await askNext({ io }), want);
      assert.deepEqual(io.calls[0].items.map((item) => item.label), SUMMARY_ACTIONS.map((item) => item.label));
      assert.equal(io.calls[0].items[0].checked, true, "Install is the default");
    }
    await assert.rejects(askNext({ io: { print() {} } }), /needs io.select/);
  });
});

describe("the debugger role (D110)", () => {
  const WITHOUT = WORKERS.filter((name) => name !== "debugger");

  function start(overrides = {}) {
    return { ...defaultChoices(MODEL), skills: defaultSelection(SKILLS), ...overrides };
  }

  test("is a worker with one agent per tier: Sonnet high at T1, Opus high at T2 and T3", () => {
    assert.ok(MODEL.workers.some((role) => role.name === "debugger"));
    assert.ok(!MODEL.required.includes("debugger"), "the debugger is optional");
    const variants = resolveSetup(MODEL, defaultChoices(MODEL)).variants.filter((variant) => variant.role === "debugger");
    assert.deepEqual(variants, [
      { role: "debugger", agent: "debugger-t1", tier: "t1", model: SONNET, effort: "high" },
      { role: "debugger", agent: "debugger-t2", tier: "t2", model: OPUS, effort: "high" },
      { role: "debugger", agent: "debugger-t3", tier: "t3", model: OPUS, effort: "high" }
    ]);
  });

  test("the agents step shows it ticked by default for every tier choice, with its hint", async () => {
    const tierSets = [["t1"], ["t2"], ["t3"], ["t1", "t2"], ["t1", "t3"], ["t2", "t3"], ["t1", "t2", "t3"]];
    for (const tiers of tierSets) {
      const io = captureIo({ selections: scriptedSelections([tiers]) });
      await askChoices({ model: MODEL, skills: SKILLS, start: start(), io });
      const item = io.calls[1].items.find((entry) => entry.value === "debugger");
      assert.ok(item, `tiers ${tiers}: the debugger is shown`);
      assert.equal(item.checked, true, `tiers ${tiers}: ticked by default`);
      assert.ok(!item.locked, `tiers ${tiers}: it can be unticked`);
      assert.equal(item.hint, "fixes a failure that came back for the same reason");
    }
  });

  test("unticked in the agents step, it is left out and its fallback shows in the step result", async () => {
    const io = captureIo({ selections: scriptedSelections([undefined, WITHOUT]) });
    const result = await askChoices({ model: MODEL, skills: SKILLS, start: start(), io });
    assert.deepEqual(result.roles, WITHOUT);
    assert.ok(io.lines.includes("Agents: planner, docs, coder, tester, reviewer, git (without debugger)"), io.text());
    assert.ok(!io.calls.some((call) => call.title === roleTitle("debugger")), "no skills list for a debugger that is not installed");
  });

  test("ticked, the skills step asks its list after the reviewer's, with debugging and context-cache locked", async () => {
    const io = captureIo();
    const result = await askChoices({ model: MODEL, skills: SKILLS, start: start(), io });
    const titles = io.calls.map((call) => call.title);
    assert.deepEqual(titles.slice(-3), [roleTitle("reviewer"), roleTitle("debugger"), roleTitle("git")]);
    const list = io.calls.find((call) => call.title === roleTitle("debugger"));
    assert.equal(list.help, ROLE_SUMMARIES.debugger);
    assert.deepEqual(list.items.filter((item) => item.locked).map((item) => item.value), ["context-cache", "debugging"]);
    assert.deepEqual(result.skills.debugger, ["context-cache", "debugging"]);
    assert.ok(io.lines.includes("debugger: 2 skills"), io.text());
  });

  test("unticked, the orchestrator gets the D110 rule and the user the plain fallback", () => {
    const setup = resolveSetup(MODEL, { tiers: MODEL.tiers, roles: WITHOUT, models: ORDER });
    assert.deepEqual(setup.missingRoles, ["debugger"]);
    assert.ok(!setup.variants.some((variant) => variant.role === "debugger"));
    assert.equal(setup.complete, false);
    assert.equal(renderSetupNotes(setup, MODEL), "- The debugger is not installed: a failure that comes back for the same reason gets one more coder fix round when the phase's cap allows; when that round does not clear it, it goes to the report.");
    assert.deepEqual(setupSummaryLines(setup, MODEL), ["debugger not installed: a repeated failure gets one more coder round, then the report"]);
  });

  test("an older saved answer that does not know the debugger ticks it as new, and a newer one keeps it unticked", () => {
    const older = { tiers: ["t1", "t2"], roles: ["planner", "docs", "coder", "tester"], models: [SONNET, HAIKU], known: { tiers: MODEL.tiers, roles: WITHOUT, models: ORDER } };
    assert.deepEqual(resolveChoices({ model: MODEL, saved: older }), { tiers: ["t1", "t2"], roles: ["planner", "docs", "coder", "tester", "debugger"], models: [SONNET, HAIKU] }, "the reviewer stays unticked, the debugger is new");
    const full = { tiers: MODEL.tiers, roles: WITHOUT, models: ORDER, known: { tiers: MODEL.tiers, roles: WITHOUT, models: ORDER } };
    assert.deepEqual(resolveChoices({ model: MODEL, saved: full }).roles, WORKERS, "a full install before D110 becomes a full install with the debugger");
    const newer = savedChoices({ tiers: MODEL.tiers, roles: WITHOUT, models: ORDER }, MODEL);
    assert.ok(newer.known.roles.includes("debugger"));
    assert.deepEqual(resolveChoices({ model: MODEL, saved: newer }).roles, WITHOUT, "an unticked debugger survives a reinstall");
  });

  test("an older saved skills answer gives the debugger its required skills", () => {
    const older = SKILLS.filter((item) => item.name !== "debugging");
    const lists = Object.fromEntries(ROLES.filter((role) => role !== "debugger").map((role) => [role, defaultSelection(older)[role]]));
    const saved = { known: older.map((item) => item.name), selection: { ...lists, reviewer: ["context-cache"] } };
    const result = resolveSelection({ skills: SKILLS, saved });
    assert.deepEqual(result.debugger, ["context-cache", "debugging"]);
    assert.deepEqual(result.reviewer, ["context-cache"]);
    for (const role of ROLES.filter((name) => name !== "debugger")) assert.ok(!result[role].includes("debugging"), `debugging stays in the library for the ${role}`);
  });

  test("in the repo skills, debugging and context-cache are required for the debugger and debugging is only in the library of the others", () => {
    const real = loadSources(path.join(here, "..")).skills;
    assert.deepEqual(real.filter((item) => item.required.includes("debugger")).map((item) => item.name), ["context-cache", "debugging"]);
    const debugging = real.find((item) => item.name === "debugging");
    assert.ok(debugging, "skills/debugging exists");
    assert.deepEqual(debugging.required, ["debugger"]);
    assert.deepEqual(debugging.defaults, []);
  });

  test("an unticked Opus moves debugger-t2 and debugger-t3 to Sonnet and keeps their high effort", () => {
    const setup = resolveSetup(MODEL, { tiers: MODEL.tiers, roles: WORKERS, models: [SONNET, HAIKU] });
    const moved = setup.variants.filter((variant) => variant.role === "debugger");
    assert.deepEqual(moved.map((variant) => [variant.agent, variant.model, variant.effort, variant.remappedFrom ?? null]), [
      ["debugger-t1", SONNET, "high", null],
      ["debugger-t2", SONNET, "high", OPUS],
      ["debugger-t3", SONNET, "high", OPUS]
    ]);
    assert.deepEqual(setup.remaps, [{ from: OPUS, to: SONNET, agents: ["orchestrator", "planner-t3", "reviewer-t3", "debugger-t2", "debugger-t3"] }]);
  });

  test("the summary table lists the debugger agents after the reviewer and the skills line counts its skills", () => {
    const choices = { ...defaultChoices(MODEL), skills: defaultSelection(SKILLS) };
    const lines = summaryLines({ setup: resolveSetup(MODEL, choices), model: MODEL, choices });
    const rows = lines.filter((line) => line.includes("wf:reviewer-t3") || line.includes("wf:debugger-t") || line.includes("wf:git "));
    assert.deepEqual(rows, [
      "                T3    wf:reviewer-t3   Opus 5.5    high",
      "  debugger      T1    wf:debugger-t1   Sonnet 5.5  high",
      "                T2    wf:debugger-t2   Opus 5.5    high",
      "                T3    wf:debugger-t3   Opus 5.5    high",
      "  git           all   wf:git           Sonnet 5.5  medium"
    ]);
    assert.ok(lines.at(-1).endsWith(", debugger 2, git 1"), lines.at(-1));
    assert.ok(lines.includes("Every tier, agent and model is installed."));
  });
});

describe("the git role (D115)", () => {
  const WITHOUT = WORKERS.filter((name) => name !== "git");

  function start(overrides = {}) {
    return { ...defaultChoices(MODEL), skills: defaultSelection(SKILLS), ...overrides };
  }

  test("is an optional single role: one wf:git agent for every tier, on the fixture's Sonnet 5.5 medium and the real Haiku 5.5 medium", () => {
    const git = MODEL.workers.find((role) => role.name === "git");
    assert.equal(git.single, true);
    assert.deepEqual(git.variants, [{ agent: "git", tier: null, model: SONNET, effort: "medium", cacheTtl: "5m" }]);
    assert.ok(!MODEL.required.includes("git"));
    assert.deepEqual(MODEL.tiers, ["t1", "t2", "t3"], "a single role adds no tier");
    const real = loadSources(path.join(here, ".."));
    const realGit = real.roles.find((role) => role.name === "git");
    assert.deepEqual(realGit.variants, [{ agent: "git", tier: null, model: HAIKU, effort: "medium", cacheTtl: "5m" }]);
    assert.equal(realGit.tools, null, "no tools line: wf:git gets every tool");
  });

  test("the agents step shows it ticked by default for every tier choice, with its hint", async () => {
    for (const tiers of [["t1"], ["t2"], ["t3"], ["t1", "t3"], ["t1", "t2", "t3"]]) {
      const io = captureIo({ selections: scriptedSelections([tiers]) });
      const result = await askChoices({ model: MODEL, skills: SKILLS, start: start(), io });
      const item = io.calls[1].items.find((entry) => entry.value === "git");
      assert.ok(item, `tiers ${tiers}: the git agent is shown`);
      assert.equal(item.checked, true, `tiers ${tiers}: ticked by default`);
      assert.ok(!item.locked, `tiers ${tiers}: it can be unticked`);
      assert.equal(item.hint, ROLE_SUMMARIES.git);
      assert.ok(result.roles.includes("git"));
      assert.equal(io.calls.at(-1).title, roleTitle("git"), `tiers ${tiers}: its skills list comes last`);
    }
  });

  test("unticked in the agents step, it is left out and its fallback shows in the step result and the notes", async () => {
    const io = captureIo({ selections: scriptedSelections([undefined, WITHOUT]) });
    const result = await askChoices({ model: MODEL, skills: SKILLS, start: start(), io });
    assert.deepEqual(result.roles, WITHOUT);
    assert.ok(io.lines.includes("Agents: planner, docs, coder, tester, reviewer, debugger (without git)"), io.text());
    assert.ok(!io.calls.some((call) => call.title === roleTitle("git")), "no skills list for a git agent that is not installed");
    const setup = resolveSetup(MODEL, { tiers: MODEL.tiers, roles: WITHOUT, models: ORDER });
    assert.deepEqual(setup.missingRoles, ["git"]);
    assert.equal(renderSetupNotes(setup, MODEL), "- The git agent is not installed: leave the work uncommitted and list the git commands in the report.");
    assert.deepEqual(setupSummaryLines(setup, MODEL), ["git not installed: the work stays uncommitted and the report lists the git commands"]);
  });

  test("an older saved answer that does not know the git role ticks it as new, and a newer one keeps it unticked", () => {
    const before = WORKERS.filter((name) => name !== "git");
    const older = { tiers: MODEL.tiers, roles: before, models: ORDER, known: { tiers: MODEL.tiers, roles: before, models: ORDER } };
    assert.deepEqual(resolveChoices({ model: MODEL, saved: older }).roles, WORKERS);
    const newer = savedChoices({ tiers: MODEL.tiers, roles: WITHOUT, models: ORDER }, MODEL);
    assert.deepEqual(resolveChoices({ model: MODEL, saved: newer }).roles, WITHOUT);
  });

  test("in the repo skills, the git skill is required for the git agent only", () => {
    const real = loadSources(path.join(here, "..")).skills;
    const git = real.find((item) => item.name === "git");
    assert.ok(git, "skills/git exists");
    assert.deepEqual(git.required, ["git"]);
    assert.deepEqual(git.defaults, []);
    const selection = defaultSelection(real);
    assert.ok(selection.git.includes("git"));
    for (const role of ROLES.filter((name) => name !== "git")) assert.ok(!selection[role].includes("git"), `the git skill stays in the library of the ${role}`);
  });
});

describe("five real tiers", () => {
  test("the real model lists t1 to t5 and each has a size word and a hint", () => {
    assert.deepEqual(REAL_MODEL.tiers, ["t1", "t2", "t3", "t4", "t5"]);
    for (const tier of REAL_MODEL.tiers) {
      assert.equal(typeof TIER_SIZES[tier], "string", `${tier}: size word`);
      assert.equal(typeof TIER_SUMMARIES[tier], "string", `${tier}: hint`);
    }
    assert.equal(TIER_SIZES.t5, "critical");
  });

  test("the tiers explanation names the five sizes", () => {
    assert.equal(explanation("tiers", REAL_MODEL)[0], "A tier is a task size: T1 small, T2 medium, T3 large, T4 major and T5 critical.");
  });

  test("the tiers step shows five rows with the hints, all ticked by default", async () => {
    const io = captureIo();
    await askChoices({ model: REAL_MODEL, skills: SKILLS, start: { ...defaultChoices(REAL_MODEL), skills: defaultSelection(SKILLS) }, io });
    assert.deepEqual(io.calls[0].items.map((item) => [item.value, item.hint, item.checked]), [
      ["t1", TIER_SUMMARIES.t1, true],
      ["t2", TIER_SUMMARIES.t2, true],
      ["t3", TIER_SUMMARIES.t3, true],
      ["t4", TIER_SUMMARIES.t4, true],
      ["t5", TIER_SUMMARIES.t5, true]
    ]);
  });

  test("a full real install has 32 agents on a Sonnet orchestrator and nothing missing", () => {
    const setup = resolveSetup(REAL_MODEL, defaultChoices(REAL_MODEL));
    assert.equal(setup.variants.length, 32);
    assert.equal(setup.complete, true);
    assert.deepEqual(setup.variants[0], { role: "orchestrator", agent: "orchestrator", tier: null, model: SONNET, effort: "medium" });
  });

  test("with T5 unticked a T5-sized task runs as T4 and the note says so", () => {
    const choices = { ...defaultChoices(REAL_MODEL), tiers: ["t1", "t2", "t3", "t4"] };
    const setup = resolveSetup(REAL_MODEL, choices);
    assert.deepEqual(setup.missingTiers, [{ tier: "t5", runsAs: "t4" }]);
    assert.equal(setup.variants.length, 26);
    assert.deepEqual(setupNoteLines(setup, REAL_MODEL), ["Tier T5 is not installed: run a T5-sized task as T4 and say so in the summary."]);
  });

  test("with T5, the reviewer and Opus 5.5 unticked, 22 agents install and only debugger-t4 moves to Sonnet 5.5", () => {
    const choices = { tiers: ["t1", "t2", "t3", "t4"], roles: ["planner", "docs", "coder", "tester", "debugger", "git"], models: [SONNET, HAIKU] };
    const setup = resolveSetup(REAL_MODEL, choices);
    assert.equal(setup.variants.length, 22);
    assert.deepEqual(setup.variants.filter((variant) => variant.remappedFrom).map((variant) => [variant.agent, variant.model, variant.remappedFrom]), [["debugger-t4", SONNET, OPUS]]);
    assert.deepEqual(setupNoteLines(setup, REAL_MODEL), [
      "Tier T5 is not installed: run a T5-sized task as T4 and say so in the summary.",
      ROLE_FALLBACKS.reviewer.agent,
      "Model Opus 5.5 is not installed: wf:debugger-t4 runs on Sonnet 5.5 with its effort unchanged."
    ]);
  });

  test("with only T1 and T4 ticked T2 runs as T1 and T3 and T5 run as T4", () => {
    const setup = resolveSetup(REAL_MODEL, { ...defaultChoices(REAL_MODEL), tiers: ["t1", "t4"] });
    assert.deepEqual(setup.missingTiers, [{ tier: "t2", runsAs: "t1" }, { tier: "t3", runsAs: "t4" }, { tier: "t5", runsAs: "t4" }]);
    assert.deepEqual(setupNoteLines(setup, REAL_MODEL), [
      "Tier T2 is not installed: run a T2-sized task as T1 and say so in the summary.",
      "Tier T3 is not installed: run a T3-sized task as T4 and say so in the summary.",
      "Tier T5 is not installed: run a T5-sized task as T4 and say so in the summary."
    ]);
  });
});

describe("tier hints (D113)", () => {
  test("describe difficulty and risk, never a file count", () => {
    assert.deepEqual(TIER_SUMMARIES, {
      t1: "mechanical or fully specified, low risk",
      t2: "new behavior or open choices in one area",
      t3: "cross-cutting, public interfaces or new ground",
      t4: "risky changes across modules or stored formats",
      t5: "risky domains, irreversible changes or extra care"
    });
    for (const hint of Object.values(TIER_SUMMARIES)) assert.doesNotMatch(hint, /\bfiles?\b|\d/, hint);
  });

  test("the tiers step shows them as the hints", async () => {
    const io = captureIo();
    await askChoices({ model: MODEL, skills: SKILLS, start: { ...defaultChoices(MODEL), skills: defaultSelection(SKILLS) }, io });
    assert.deepEqual(io.calls[0].items.map((item) => item.hint), [TIER_SUMMARIES.t1, TIER_SUMMARIES.t2, TIER_SUMMARIES.t3]);
  });
});

describe("answer and summary lines in a narrow terminal", () => {
  const REAL = loadSources(path.join(here, ".."));
  const REAL_MODEL = installModel({ registry: REAL.registry, roles: REAL.roles });
  const subsets = (list) => list.reduce((all, item) => [...all, ...all.map((subset) => [...subset, item])], [[]]).filter((subset) => subset.length > 0);

  test("modelsAnswer names the ticked models and how many agents run on a stand-in", () => {
    assert.equal(modelsAnswer(MODEL, MODEL.tiers, WORKERS, ORDER), "Opus 5.5, Sonnet 5.5, Haiku 5.5");
    assert.equal(modelsAnswer(MODEL, ["t1", "t2"], ["planner", "docs", "coder", "tester"], [SONNET, HAIKU]), "Sonnet 5.5, Haiku 5.5 (1 agent on a stand-in)");
    const all = resolveSetup(MODEL, { tiers: MODEL.tiers, roles: WORKERS, models: [HAIKU] }).remaps.reduce((sum, remap) => sum + remap.agents.length, 0);
    assert.equal(modelsAnswer(MODEL, MODEL.tiers, WORKERS, [HAIKU]), `Haiku 5.5 (${all} agents on a stand-in)`);
    assert.equal(skillsAnswer(["a", "b"]), "2 skills");
    assert.equal(skillsAnswer(["a"]), "1 skill");
    assert.equal(skillsAnswer([]), "no skills");
  });

  test("every models answer and the longest skills answer fit one line at 60 columns, with no cut", () => {
    const ui = createUi({ rich: true, unicode: true, color: true, columns: 60 });
    const roles = REAL_MODEL.workers.map((role) => role.name);
    for (const tiers of subsets(REAL_MODEL.tiers)) {
      for (const models of subsets(REAL_MODEL.models)) {
        const lines = ui.done("Models", modelsAnswer(REAL_MODEL, tiers, roles, models)).map(stripAnsi);
        assert.equal(lines.length, 1, JSON.stringify(lines));
        assert.ok(visibleLength(lines[0]) <= 59 && !lines[0].endsWith("\u2026"), lines[0]);
      }
    }
    const longest = [...ROLES].sort((a, b) => b.length - a.length)[0];
    const skills = ui.done(longest, skillsAnswer(REAL.skills.map((entry) => entry.name))).map(stripAnsi);
    assert.equal(skills.length, 1, JSON.stringify(skills));
    assert.ok(visibleLength(skills[0]) <= 59, skills[0]);
  });

  test("the summary screen keeps every line inside the width at 60 and 80 columns and never splits a role from its count", () => {
    const full = { ...defaultChoices(REAL_MODEL), skills: defaultSelection(REAL.skills) };
    const smaller = { tiers: ["t1", "t2"], roles: ["planner", "docs", "coder", "tester"], models: [SONNET, HAIKU], skills: defaultSelection(REAL.skills) };
    for (const columns of [60, 80]) {
      for (const unicode of [true, false]) {
        const ui = createUi({ rich: true, unicode, color: true, columns });
        for (const choices of [full, smaller]) {
          const setup = resolveSetup(REAL_MODEL, choices);
          const lines = summaryLines({ setup, model: REAL_MODEL, choices, ui }).map(stripAnsi);
          for (const line of lines) assert.ok(visibleLength(line) <= columns - 1, `${columns} columns: ${JSON.stringify(line)}`);
          const head = lines.find((line) => line.trim().startsWith("Role "));
          const legend = lines.find((line) => line.includes("runs on a stand-in"));
          if (legend) assert.equal(/^ */.exec(legend)[0], /^ */.exec(head)[0], `${columns} columns: the legend lines up with the table`);
          assert.ok(!lines.some((line) => line.includes("\u00a0")), "the glue prints as a plain space");
          const at = lines.findIndex((line) => line.includes("Skills: "));
          const skillsText = lines.slice(at);
          for (const role of setup.roles.filter((entry) => entry.status === "installed").map((entry) => entry.name)) {
            const count = choices.skills[role].length;
            assert.ok(skillsText.some((line) => line.includes(`${role} ${count}`)), `${columns} columns: ${role} ${count} stays on one line in ${JSON.stringify(skillsText)}`);
          }
        }
      }
    }
  });
});
