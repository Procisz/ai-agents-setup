import { ROLES, isPlainObject } from "./skills.mjs";
import { NBSP, PLAIN_UI } from "./ui.mjs";

export const ROLE_SUMMARIES = Object.freeze({
  orchestrator: "the main thread: triage, discussion, the approval, delegation and the report",
  planner: "writes the execution plan of every task",
  docs: "updates the project docs a task affects",
  coder: "implements the plan and runs the fast checks",
  tester: "writes and runs the tests after the code",
  reviewer: "reviews the change when the user asks for a review",
  debugger: "fixes a failure that came back for the same reason",
  git: "branches, commits, pushes and opens pull requests when the summary asks"
});

export const TIER_SIZES = Object.freeze({ t1: "small", t2: "medium", t3: "large", t4: "major", t5: "critical" });

export const TIER_SUMMARIES = Object.freeze({
  t1: "mechanical or fully specified, low risk",
  t2: "new behavior or open choices in one area",
  t3: "cross-cutting, public interfaces or new ground",
  t4: "risky changes across modules or stored formats",
  t5: "risky domains, irreversible changes or extra care"
});

export const ROLE_FALLBACKS = Object.freeze({
  planner: {
    user: "a coder of the task's tier writes plan.md in a plan-only round first",
    agent: "The planner is not installed: a coder of the task's tier writes plan.md in a plan-only round before implementation."
  },
  docs: {
    user: "the coder does the docs steps",
    agent: "The docs agent is not installed: the coder does the docs steps of plan.md in its package."
  },
  tester: {
    user: "the coder writes and runs the tests after its code",
    agent: "The tester is not installed: the coder writes and runs the tests after its code."
  },
  reviewer: {
    user: "a coder of the tier reviews in a separate read-only round when asked",
    agent: "The reviewer is not installed: when the user asks for a review, a coder of the task's tier does a separate read-only review round with the code-review skill."
  },
  debugger: {
    user: "a repeated failure gets one more coder round, then the report",
    agent: "The debugger is not installed: a failure that comes back for the same reason gets one more coder fix round when the phase's cap allows; when that round does not clear it, it goes to the report."
  },
  git: {
    user: "the work stays uncommitted and the report lists the git commands",
    agent: "The git agent is not installed: leave the work uncommitted and list the git commands in the report."
  }
});

export const ROLE_NOUNS = Object.freeze({ docs: "the docs agent", git: "the git agent" });

export function roleNoun(name, { capital = false } = {}) {
  const noun = ROLE_NOUNS[name] ?? `the ${name}`;
  return capital ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)}` : noun;
}

export const REQUIRED_HINT = "required";
export const LOCKED_ROLE_HINT = "needed by every tier";
export const EVERYTHING_INSTALLED = "Everything is installed.";
export const STEP_COUNT = 5;

export const STEPS = Object.freeze({
  tiers: { number: 1, emoji: "\u{1F4CA}", title: "Tiers" },
  agents: { number: 2, emoji: "\u{1F916}", title: "Agents" },
  models: { number: 3, emoji: "\u{1F9E0}", title: "Models" },
  skills: { number: 4, emoji: "\u{1F9E9}", title: "Skills" },
  summary: { number: 5, emoji: "\u{1F4CB}", title: "Summary" }
});

export const SUMMARY_ACTIONS = Object.freeze([
  { value: "install", label: "Install", hint: "write the files now; a backup comes first" },
  { value: "change", label: "Change choices", hint: "start again at step 1 with these answers ticked" },
  { value: "cancel", label: "Cancel", hint: "stop here; nothing is written" }
]);

function unique(list) {
  return [...new Set(list)];
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : null;
}

function tierNumber(tier) {
  const match = /^t(\d+)$/.exec(String(tier));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function tierLabel(tier) {
  return String(tier).toUpperCase();
}

export function joinList(items) {
  const list = [...items];
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function installModel({ registry, roles } = {}) {
  const list = Array.isArray(roles) ? roles : [];
  const main = list.find((role) => role.main) ?? null;
  const workers = list.filter((role) => !role.main);
  const tiers = unique(workers.flatMap((role) => role.variants.map((variant) => variant.tier)).filter((tier) => typeof tier === "string")).sort((a, b) => tierNumber(a) - tierNumber(b));
  const known = isPlainObject(registry?.models) ? Object.keys(registry.models) : [];
  const listed = (strings(registry?.install?.models) ?? []).filter((id) => known.includes(id));
  const used = list.flatMap((role) => role.variants.map((variant) => variant.model)).filter((id) => typeof id === "string");
  const models = unique([...listed, ...known, ...used]);
  const required = (strings(registry?.install?.requiredRoles) ?? []).filter((name) => workers.some((role) => role.name === name));
  const labels = Object.fromEntries(models.map((id) => [id, typeof registry?.models?.[id]?.label === "string" ? registry.models[id].label : id]));
  const plugin = typeof registry?.plugin?.name === "string" ? registry.plugin.name : "wf";
  return { main, workers, tiers, models, required, labels, plugin };
}

export function modelLabel(model, id) {
  return model.labels?.[id] ?? id;
}

export function defaultChoices(model) {
  return { tiers: [...model.tiers], roles: model.workers.map((role) => role.name), models: [...model.models] };
}

function resolveList(all, saved, known, locked = []) {
  const chosen = strings(saved);
  if (chosen === null) return [...all];
  const picked = new Set(chosen);
  const seen = new Set(strings(known) ?? chosen);
  return all.filter((id) => locked.includes(id) || (seen.has(id) ? picked.has(id) : true));
}

export function resolveChoices({ model, saved, reset = false } = {}) {
  const base = defaultChoices(model);
  if (reset || !isPlainObject(saved)) return base;
  const known = isPlainObject(saved.known) ? saved.known : {};
  const tiers = resolveList(model.tiers, saved.tiers, known.tiers);
  const models = resolveList(model.models, saved.models, known.models);
  const roles = resolveList(base.roles, saved.roles, known.roles, model.required);
  return { tiers: tiers.length > 0 ? tiers : base.tiers, roles, models: models.length > 0 ? models : base.models };
}

export function savedChoices(choices, model) {
  return {
    tiers: [...choices.tiers],
    roles: [...choices.roles],
    models: [...choices.models],
    known: { tiers: [...model.tiers], roles: model.workers.map((role) => role.name), models: [...model.models] }
  };
}

export function nearestTier(tier, installed, order) {
  if (installed.includes(tier)) return tier;
  const from = order.indexOf(tier);
  let best = null;
  for (const candidate of installed) {
    const at = order.indexOf(candidate);
    if (at === -1 || from === -1) continue;
    const distance = Math.abs(at - from);
    if (best === null || distance < best.distance || (distance === best.distance && at > best.at)) best = { tier: candidate, distance, at };
  }
  return best ? best.tier : null;
}

export function remapModel(model, allowed, order) {
  if (allowed.includes(model)) return model;
  const from = order.indexOf(model);
  if (from === -1) return model;
  let best = null;
  for (const candidate of allowed) {
    const at = order.indexOf(candidate);
    if (at === -1) continue;
    const distance = Math.abs(at - from);
    if (best === null || distance < best.distance || (distance === best.distance && at < best.at)) best = { model: candidate, distance, at };
  }
  return best ? best.model : model;
}

function checkIds(kind, list, all) {
  if (!Array.isArray(list)) throw new Error(`choices.${kind} must be a list`);
  for (const id of list) {
    if (!all.includes(id)) throw new Error(`choices.${kind} names unknown ${kind.slice(0, -1)} ${id}`);
  }
}

export function validateChoices(model, choices) {
  if (!isPlainObject(choices)) throw new Error("choices must be an object of tiers, roles and models");
  checkIds("tiers", choices.tiers, model.tiers);
  checkIds("roles", choices.roles, model.workers.map((role) => role.name));
  checkIds("models", choices.models, model.models);
  if (choices.tiers.length === 0) throw new Error("choices.tiers needs at least one tier");
  if (choices.models.length === 0) throw new Error("choices.models needs at least one model");
}

export function isSingleRole(role) {
  return role?.single === true && role?.main !== true;
}

function usesVariant(role, variant, tiers) {
  return isSingleRole(role) ? tiers.length > 0 : tiers.includes(variant.tier);
}

export function roleStatus(model, role, tiers, roles) {
  const used = isSingleRole(role) ? [...tiers] : role.variants.map((variant) => variant.tier).filter((tier) => tiers.includes(tier));
  if (used.length === 0) return { status: "unused", tiers: used };
  if (model.required.includes(role.name) || roles.includes(role.name)) return { status: "installed", tiers: used };
  return { status: "missing", tiers: used };
}

export function resolveSetup(model, choices) {
  const chosen = choices ?? defaultChoices(model);
  const tierList = model.tiers.filter((tier) => chosen.tiers.includes(tier));
  const tiers = tierList.length > 0 ? tierList : [...model.tiers];
  const modelList = model.models.filter((id) => chosen.models.includes(id));
  const models = modelList.length > 0 ? modelList : [...model.models];
  const missingTiers = model.tiers.filter((tier) => !tiers.includes(tier)).map((tier) => ({ tier, runsAs: nearestTier(tier, tiers, model.tiers) }));
  const roles = [];
  const missingRoles = [];
  const variants = [];
  const groups = new Map();
  const place = (role, variant) => {
    const to = remapModel(variant.model, models, model.models);
    const entry = { role: role.name, agent: variant.agent, tier: variant.tier, model: to, effort: variant.effort };
    if (to !== variant.model) {
      entry.remappedFrom = variant.model;
      if (!groups.has(variant.model)) groups.set(variant.model, { from: variant.model, to, agents: [] });
      groups.get(variant.model).agents.push(variant.agent);
    }
    variants.push(entry);
  };
  if (model.main) {
    roles.push({ name: model.main.name, status: "installed", main: true, tiers: [] });
    for (const variant of model.main.variants) place(model.main, variant);
  }
  for (const role of model.workers) {
    const { status, tiers: used } = roleStatus(model, role, tiers, chosen.roles);
    roles.push({ name: role.name, status, main: false, tiers: used, required: model.required.includes(role.name) });
    if (status === "missing") missingRoles.push(role.name);
    if (status !== "installed") continue;
    for (const variant of role.variants) if (usesVariant(role, variant, tiers)) place(role, variant);
  }
  const remaps = model.models.filter((id) => groups.has(id)).map((id) => groups.get(id));
  return { tiers, models, missingTiers, roles, missingRoles, variants, remaps, complete: missingTiers.length === 0 && missingRoles.length === 0 && remaps.length === 0 };
}

export function installedRoleNames(setup) {
  return setup.roles.filter((role) => role.status === "installed").map((role) => role.name);
}

function agentList(model, agents) {
  return joinList(agents.map((agent) => `${model.plugin}:${agent}`));
}

export function setupNoteLines(setup, model) {
  const lines = [];
  for (const { tier, runsAs } of setup.missingTiers) {
    lines.push(`Tier ${tierLabel(tier)} is not installed: run a ${tierLabel(tier)}-sized task as ${tierLabel(runsAs)} and say so in the summary.`);
  }
  for (const name of setup.missingRoles) lines.push(ROLE_FALLBACKS[name]?.agent ?? `${roleNoun(name, { capital: true })} is not installed.`);
  for (const remap of setup.remaps) {
    const one = remap.agents.length === 1;
    lines.push(`Model ${modelLabel(model, remap.from)} is not installed: ${agentList(model, remap.agents)} ${one ? "runs" : "run"} on ${modelLabel(model, remap.to)} with ${one ? "its" : "their"} effort unchanged.`);
  }
  return lines;
}

export function renderSetupNotes(setup, model) {
  const lines = setupNoteLines(setup, model);
  return lines.length === 0 ? EVERYTHING_INSTALLED : lines.map((line) => `- ${line}`).join("\n");
}

export function setupSummaryLines(setup, model) {
  const lines = [];
  for (const { tier, runsAs } of setup.missingTiers) lines.push(`${tierLabel(tier)} not installed: a ${tierLabel(tier)}-sized task runs as ${tierLabel(runsAs)}`);
  for (const name of setup.missingRoles) lines.push(`${name} not installed: ${ROLE_FALLBACKS[name]?.user ?? "its work is not done"}`);
  for (const remap of setup.remaps) {
    const one = remap.agents.length === 1;
    lines.push(`${modelLabel(model, remap.from)} not installed: ${joinList(remap.agents)} ${one ? "runs" : "run"} on ${modelLabel(model, remap.to)}`);
  }
  return lines;
}

function namesOf(skills) {
  return (Array.isArray(skills) ? skills : []).map((skill) => skill.name);
}

function isRequired(skill, role) {
  return Array.isArray(skill.required) && skill.required.includes(role);
}

function isDefault(skill, role) {
  return Array.isArray(skill.defaults) && skill.defaults.includes(role);
}

export function defaultSelection(skills) {
  const list = Array.isArray(skills) ? skills : [];
  const selection = {};
  for (const role of ROLES) {
    selection[role] = list.filter((skill) => isRequired(skill, role) || isDefault(skill, role)).map((skill) => skill.name);
  }
  return selection;
}

export function normalizeSaved(saved) {
  if (!isPlainObject(saved)) return null;
  const roles = isPlainObject(saved.selection) ? saved.selection : saved;
  const lists = {};
  for (const role of ROLES) {
    const list = strings(roles[role]);
    if (list !== null) lists[role] = list;
  }
  const declared = isPlainObject(saved.selection) ? (strings(saved.known) ?? strings(saved.skills)) : null;
  const known = new Set(declared ?? Object.values(lists).flat());
  return { lists, known };
}

export function resolveSelection({ skills, saved, reset = false } = {}) {
  const list = Array.isArray(skills) ? skills : [];
  const answer = reset ? null : normalizeSaved(saved);
  if (answer === null) return defaultSelection(list);
  const selection = {};
  for (const role of ROLES) {
    const chosen = answer.lists[role];
    selection[role] = list
      .filter((skill) => {
        if (isRequired(skill, role)) return true;
        if (chosen === undefined || !answer.known.has(skill.name)) return isDefault(skill, role);
        return chosen.includes(skill.name);
      })
      .map((skill) => skill.name);
  }
  return selection;
}

export function savedAnswer(selection, skills) {
  const out = {};
  for (const role of ROLES) out[role] = [...(strings(selection?.[role]) ?? [])];
  return { selection: out, known: namesOf(skills) };
}

export function roleTitle(role) {
  return `Skills for the ${role}`;
}

export function roleItems(skills, role, current) {
  const picked = new Set(Array.isArray(current) ? current : []);
  return (Array.isArray(skills) ? skills : []).map((skill) => {
    const locked = isRequired(skill, role);
    return {
      label: skill.name,
      value: skill.name,
      checked: locked || picked.has(skill.name),
      locked,
      hint: locked ? REQUIRED_HINT : skill.description ?? ""
    };
  });
}

export function formatSelection(selection, roles = ROLES) {
  return roles.map((role) => {
    const names = strings(selection?.[role]) ?? [];
    return `${role}: ${names.length > 0 ? names.join(", ") : "none"}`;
  });
}

export function resolveStart({ model, skills, saved, reset = false } = {}) {
  const choices = resolveChoices({ model, saved: saved?.choices ?? null, reset });
  const selection = resolveSelection({ skills, saved: saved?.skills ?? null, reset });
  return { ...choices, skills: selection };
}

function print(io, lines) {
  for (const line of Array.isArray(lines) ? lines : [lines]) io.print(line);
}

function stepLines(ui, key) {
  const step = STEPS[key];
  return ui.step({ number: step.number, total: STEP_COUNT, emoji: step.emoji, title: step.title });
}

function introLines(ui, key, model) {
  return [...stepLines(ui, key), ...ui.explain(explanation(key, model)), ...ui.blank()];
}

export function explanation(key, model) {
  const strongest = modelLabel(model, model.models[0]);
  const lightest = modelLabel(model, model.models[model.models.length - 1]);
  const sizes = joinList(model.tiers.map((tier) => `${tierLabel(tier)} ${TIER_SIZES[tier] ?? "tasks"}`));
  const locked = model.required.length > 0 ? ` The ${joinList(model.required)} ${model.required.length === 1 ? "is" : "are"} needed by every tier.` : "";
  const agentDefault = `Default: all of them.${locked}`;
  const texts = {
    tiers: [
      `A tier is a task size: ${sizes}.`,
      "Untick one and its tasks run as the nearest tier left, the higher on a tie.",
      "Default: all of them. T0, questions and tiny edits, needs no agents."
    ],
    agents: [
      "Each agent does one job; the orchestrator, the main thread, is always there.",
      "Untick one and another agent takes over its work, as shown under the list.",
      agentDefault,
      "Agents that none of your tiers use are hidden."
    ],
    models: [
      `Each agent has a set model: ${strongest} strongest, ${lightest} lightest.`,
      "Untick one: its agents use the nearest ticked model, the stronger on a tie.",
      "Their effort stays the same. Default: all of them; keep at least one."
    ],
    skills: [
      "Skills are instructions; a ticked skill is built into the agent's prompt.",
      "Unticked skills stay in a library the agent reads when a task needs one.",
      "Default: each agent's recommended skills. Required skills are locked."
    ],
    summary: ["Check the setup below. Nothing is written until you choose Install,", "and every file it changes is backed up first."]
  };
  return texts[key];
}

function tierItems(model, tiers) {
  return model.tiers.map((tier) => ({
    label: tierLabel(tier),
    value: tier,
    checked: tiers.includes(tier),
    hint: TIER_SUMMARIES[tier] ?? "",
    detail: (values) => {
      const others = values.filter((value) => value !== tier);
      const runsAs = nearestTier(tier, others, model.tiers);
      if (values.includes(tier)) return runsAs ? `Untick ${tierLabel(tier)}: a ${tierLabel(tier)}-sized task would run as ${tierLabel(runsAs)}` : "At least one tier is needed";
      return runsAs ? `${tierLabel(tier)} is skipped: a ${tierLabel(tier)}-sized task runs as ${tierLabel(runsAs)}` : "Tick at least one tier";
    }
  }));
}

function agentItems(model, tiers, roles) {
  return model.workers
    .map((role) => ({ role, ...roleStatus(model, role, tiers, roles) }))
    .filter((entry) => entry.status !== "unused")
    .map(({ role }) => {
      const locked = model.required.includes(role.name);
      const fallback = ROLE_FALLBACKS[role.name]?.user ?? "its work is not done";
      return {
        label: role.name,
        value: role.name,
        checked: locked || roles.includes(role.name),
        locked,
        hint: locked ? LOCKED_ROLE_HINT : ROLE_SUMMARIES[role.name] ?? role.name,
        detail: locked ? `${roleNoun(role.name, { capital: true })} is ${LOCKED_ROLE_HINT}` : (values) => (values.includes(role.name) ? `Untick ${roleNoun(role.name)}: ${fallback}` : `Without ${roleNoun(role.name)}: ${fallback}`)
      };
    });
}

function modelCounts(model, tiers, roles) {
  const setup = resolveSetup(model, { tiers, roles, models: model.models });
  const counts = Object.fromEntries(model.models.map((id) => [id, 0]));
  for (const variant of setup.variants) counts[variant.model] = (counts[variant.model] ?? 0) + 1;
  return counts;
}

function modelItems(model, tiers, roles, models) {
  const counts = modelCounts(model, tiers, roles);
  return model.models.map((id) => {
    const count = counts[id] ?? 0;
    const agents = `${count} agent${count === 1 ? "" : "s"}`;
    return {
      label: modelLabel(model, id),
      value: id,
      checked: models.includes(id),
      hint: count > 0 ? `set for ${agents}` : "no installed agent is set to it",
      detail: (values) => {
        const others = values.filter((value) => value !== id);
        if (others.length === 0) return values.includes(id) ? "At least one model is needed" : "Tick at least one model";
        if (count === 0) return "No installed agent is set to it";
        const to = modelLabel(model, remapModel(id, others, model.models));
        const verb = count === 1 ? "runs" : "run";
        return values.includes(id) ? `Untick ${modelLabel(model, id)}: its ${agents} would run on ${to}` : `${modelLabel(model, id)} is off: its ${agents} ${verb} on ${to}`;
      }
    };
  });
}

function tiersAnswer(model, tiers) {
  const setup = resolveSetup(model, { tiers, roles: [], models: model.models });
  const missing = setup.missingTiers.map(({ tier, runsAs }) => `${tierLabel(tier)} runs as ${tierLabel(runsAs)}`);
  return `${tiers.map(tierLabel).join(", ")}${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`;
}

function agentsAnswer(model, tiers, roles) {
  const setup = resolveSetup(model, { tiers, roles, models: model.models });
  const installed = setup.roles.filter((role) => !role.main && role.status === "installed").map((role) => role.name);
  return `${installed.join(", ")}${setup.missingRoles.length > 0 ? ` (without ${joinList(setup.missingRoles)})` : ""}`;
}

export function modelsAnswer(model, tiers, roles, models) {
  const setup = resolveSetup(model, { tiers, roles, models });
  const ticked = models.map((id) => modelLabel(model, id)).join(", ");
  const moved = setup.remaps.reduce((sum, remap) => sum + remap.agents.length, 0);
  return moved === 0 ? ticked : `${ticked} (${moved} agent${moved === 1 ? "" : "s"} on a stand-in)`;
}

export function skillsAnswer(names) {
  return names.length > 0 ? `${names.length} skill${names.length === 1 ? "" : "s"}` : "no skills";
}

export async function askSkills({ skills, start, roles, io, ui = PLAIN_UI }) {
  const list = Array.isArray(skills) ? skills : [];
  const selection = {};
  for (const role of ROLES) selection[role] = [...(start?.[role] ?? [])];
  if (list.length === 0) return selection;
  for (const role of roles) {
    const items = roleItems(list, role, selection[role]);
    const answer = await io.multiSelect({ title: roleTitle(role), help: ROLE_SUMMARIES[role], items });
    if (answer === null || answer === undefined) return null;
    const picked = new Set(answer);
    selection[role] = list.filter((skill) => isRequired(skill, role) || picked.has(skill.name)).map((skill) => skill.name);
    print(io, ui.done(role, skillsAnswer(selection[role])));
  }
  return selection;
}

export async function askChoices({ model, skills, start, io, ui = PLAIN_UI }) {
  if (!io || typeof io.multiSelect !== "function") throw new Error("askChoices: an interactive run needs io.multiSelect");
  print(io, introLines(ui, "tiers", model));
  const tiers = await io.multiSelect({ title: "Which tiers should wf install?", items: tierItems(model, start.tiers), min: 1 });
  if (!tiers) return null;
  print(io, ui.done("Tiers", tiersAnswer(model, tiers)));

  print(io, introLines(ui, "agents", model));
  const shown = agentItems(model, tiers, start.roles);
  const picked = await io.multiSelect({ title: "Which agents should wf install?", items: shown, min: 0 });
  if (!picked) return null;
  const shownNames = shown.map((item) => item.value);
  const roles = model.workers.map((role) => role.name).filter((name) => model.required.includes(name) || (shownNames.includes(name) ? picked.includes(name) : start.roles.includes(name)));
  print(io, ui.done("Agents", agentsAnswer(model, tiers, roles)));

  print(io, introLines(ui, "models", model));
  const models = await io.multiSelect({ title: "Which models should wf use?", items: modelItems(model, tiers, roles, start.models), min: 1 });
  if (!models) return null;
  print(io, ui.done("Models", modelsAnswer(model, tiers, roles, models)));

  print(io, introLines(ui, "skills", model));
  const installed = installedRoleNames(resolveSetup(model, { tiers, roles, models }));
  const selection = await askSkills({ skills, start: start.skills, roles: installed, io, ui });
  if (!selection) return null;
  return { tiers, roles, models, skills: selection };
}

export function skillCounts(selection, roles) {
  return roles.map((role) => `${role} ${(strings(selection?.[role]) ?? []).length}`);
}

export function summaryTable(setup, model, ui = PLAIN_UI) {
  const rows = [];
  let last = null;
  for (const variant of setup.variants) {
    const remapped = Boolean(variant.remappedFrom);
    rows.push([
      { text: variant.role === last ? "" : variant.role, style: "bold" },
      { text: variant.tier !== null ? tierLabel(variant.tier) : variant.role === model.main?.name ? "main" : "all" },
      { text: `${model.plugin}:${variant.agent}`, style: "cyan" },
      { text: `${modelLabel(model, variant.model)}${remapped ? ui.sym("remap") : ""}`, style: remapped ? "yellow" : null },
      { text: variant.effort ?? "", style: "dim" }
    ]);
    last = variant.role;
  }
  const lines = ui.table(rows, { header: ["Role", "Tier", "Agent", "Model", "Effort"], indent: ui.rich ? "    " : "  " });
  const indent = /^ */.exec(lines[0] ?? "")[0];
  if (setup.remaps.length > 0) lines.push(`${indent}${ui.paint("yellow", ui.sym("remap"))}${ui.paint("dim", " runs on a stand-in: its set model is not installed")}`);
  return lines;
}

export function summaryLines({ setup, model, choices, ui = PLAIN_UI }) {
  const lines = introLines(ui, "summary", model);
  lines.push(...summaryTable(setup, model, ui), ...ui.blank());
  const notes = setupSummaryLines(setup, model);
  if (notes.length === 0) lines.push(...ui.status("ok", "Every tier, agent and model is installed."));
  for (const note of notes) lines.push(...ui.status("warn", note, { plain: `  note: ${note}` }));
  const counts = skillCounts(choices.skills, installedRoleNames(setup));
  const glued = counts.map((count) => count.replace(/ /g, NBSP));
  const sep = ui.unicode ? `${NBSP}${ui.sym("sep")} ` : ", ";
  lines.push(...ui.status("info", `Skills: ${glued.join(sep)}`, { plain: `  Skills: ${counts.join(", ")}` }));
  return lines;
}

export function choiceLines({ setup, model, choices, ui = PLAIN_UI }) {
  const installedWorkers = setup.roles.filter((role) => !role.main && role.status === "installed").map((role) => role.name);
  const lines = [
    ...ui.done("Tiers", setup.tiers.map(tierLabel).join(", ")),
    ...ui.done("Agents", installedWorkers.join(", ")),
    ...ui.done("Models", setup.models.map((id) => modelLabel(model, id)).join(", ")),
    ...ui.done("Skills", skillCounts(choices.skills, installedRoleNames(setup)).join(", "))
  ];
  for (const note of setupSummaryLines(setup, model)) lines.push(...ui.status("warn", note, { plain: `note: ${note}` }));
  return lines;
}

export async function askNext({ io, ui = PLAIN_UI }) {
  if (typeof io.select !== "function") throw new Error("askNext: an interactive run needs io.select");
  const answer = await io.select({ title: "Install now?", items: SUMMARY_ACTIONS.map((item, index) => ({ ...item, checked: index === 0 })) });
  if (answer === null || answer === undefined) return "cancel";
  const action = SUMMARY_ACTIONS.find((item) => item.value === answer);
  if (action) print(io, ui.done("Summary", action.label));
  return action ? action.value : "cancel";
}
