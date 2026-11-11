import fs from "node:fs";
import path from "node:path";
import { ROLES, SKILLS_DIR, SKILL_FILE, compareText, isPlainObject, loadSkills, normalizeText } from "./skills.mjs";
import { EVERYTHING_INSTALLED, defaultChoices, defaultSelection, installModel, renderSetupNotes, resolveSetup, validateChoices } from "./select.mjs";

export const REGISTRY_FILE = "registry.json";
export const CONFIG_MODE = 0o644;
export const EXEC_MODE = 0o755;
export const PLACEHOLDER_NAMES = Object.freeze([
  "agentTable",
  "setupNotes",
  "warnTokens",
  "handoffTokens",
  "compactTokens",
  "windowTokens",
  "keepwarmMinutes",
  "keepwarmShortMinutes",
  "keepwarmShortMaxMinutes",
  "bufferStepTokens",
  "overEveryCalls",
  "skillDir",
  "libraryDir"
]);
export const SKILL_ONLY_PLACEHOLDERS = Object.freeze(["skillDir"]);
export const PLACEHOLDER_PATTERN = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
export const GUARD_SCRIPT = "hooks/guard.mjs";
export const CONTEXT_SCRIPT = "hooks/context.mjs";
export const COMPACT_SCRIPT = "hooks/compact.mjs";
export const TITLE_SCRIPT = "hooks/title.mjs";
export const HOOK_TIMEOUT_SECONDS = 10;
export const TITLE_HOOK_TIMEOUT_SECONDS = 15;
export const GUARD_FILTERS = Object.freeze(["Bash(*git*)", "Bash(*gh *)"]);
export const POWERSHELL_GUARD_FILTERS = Object.freeze(["PowerShell(*git*)", "PowerShell(*gh *)"]);
export const LAUNCHER_COMMAND = "claude";
export const WF_SETTINGS_FILE = "wf-settings.json";

const CONFIG_KEYS = ["window", "warnTokens", "handoffTokens", "compactTokens", "bufferStepTokens", "overEveryCalls"];
const KEEPWARM_KEYS = ["keepwarmMinutes", "keepwarmPollSeconds", "keepwarmShortMinutes", "keepwarmShortMaxMinutes"];
const PLAIN_YAML = /^[A-Za-z0-9_][A-Za-z0-9 _.,()/+-]*$/;
const YAML_KEYWORDS = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
const SAFE_WORD = /^[A-Za-z0-9_:.@/+=-]+$/;

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function toPosix(text) {
  return String(text).replace(/\\/g, "/");
}

function tierNumber(key) {
  const match = /^t(\d+)$/.exec(key);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function normalizeRoles(registry) {
  const roles = isPlainObject(registry?.roles) ? registry.roles : {};
  return Object.entries(roles)
    .filter(([, role]) => isPlainObject(role))
    .map(([name, role]) => {
      const main = role.main === true;
      const single = !main && role.single === true;
      const tiers = isPlainObject(role.tiers) ? role.tiers : {};
      const ttl = role.cacheTtl === undefined ? {} : { cacheTtl: role.cacheTtl };
      const variants = main || single
        ? [{ agent: name, tier: null, model: role.model, effort: role.effort, ...ttl }]
        : Object.keys(tiers)
            .sort((a, b) => tierNumber(a) - tierNumber(b) || compareText(a, b))
            .map((tier) => ({ agent: `${name}-${tier}`, tier, model: tiers[tier]?.model, effort: tiers[tier]?.effort, ...ttl }));
      return {
        name,
        main,
        single,
        body: role.body,
        description: role.description,
        tools: main || (single && !Array.isArray(role.tools)) ? null : listOf(role.tools).filter((tool) => typeof tool === "string"),
        color: role.color,
        variants
      };
    });
}

function insideRoot(root, relPath) {
  if (typeof relPath !== "string" || relPath === "" || path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return null;
  const full = path.resolve(root, ...toPosix(relPath).split("/"));
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

function readRepoText(root, relPath, label, problems) {
  const full = insideRoot(root, relPath);
  if (full === null) {
    problems.push({ level: "error", where: REGISTRY_FILE, message: `${label}: ${JSON.stringify(relPath)} must be a relative path inside the repository` });
    return null;
  }
  try {
    return normalizeText(fs.readFileSync(full));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR") {
      problems.push({ level: "error", where: toPosix(relPath), message: `${label} is missing; create it or fix the path in registry.json` });
      return null;
    }
    throw error;
  }
}

function fileEntries(list, root, label, problems) {
  return listOf(list)
    .filter(isPlainObject)
    .map((entry) => ({
      source: entry.source,
      target: entry.target,
      text: typeof entry.source === "string" ? readRepoText(root, entry.source, `${label} ${entry.source}`, problems) : null
    }));
}

export function loadRegistry(repoRoot) {
  const file = path.join(repoRoot, REGISTRY_FILE);
  let text;
  try {
    text = normalizeText(fs.readFileSync(file));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${REGISTRY_FILE} is missing in ${repoRoot}`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${REGISTRY_FILE} is not valid JSON: ${error.message}`);
  }
}

export function loadSources(repoRoot) {
  const root = path.resolve(repoRoot);
  const registry = loadRegistry(root);
  const problems = [];
  const roles = normalizeRoles(registry);
  const personas = {};
  for (const role of roles) {
    if (typeof role.body !== "string") continue;
    const text = readRepoText(root, role.body, `role ${role.name} body`, problems);
    if (text !== null) personas[role.name] = text;
  }
  const workerPath = isPlainObject(registry?.blocks) ? registry.blocks.worker : undefined;
  const workerBlock = typeof workerPath === "string" ? readRepoText(root, workerPath, "worker block", problems) : null;
  const rules = fileEntries(registry?.rules, root, "rule", problems);
  const hookScripts = fileEntries(registry?.hookScripts, root, "hook script", problems);
  const scripts = fileEntries(registry?.scripts, root, "script", problems);
  const loaded = loadSkills(path.join(root, SKILLS_DIR), SKILLS_DIR);
  return {
    repoRoot: root,
    registry,
    roles,
    personas,
    workerBlock,
    rules,
    skills: loaded.skills,
    hookScripts,
    scripts,
    problems: [...problems, ...loaded.problems]
  };
}

export function formatTokens(count) {
  if (count % 1000000 === 0) return `${count / 1000000}M`;
  if (count % 1000 === 0) return `${count / 1000}K`;
  return String(count);
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|");
}

export function agentName(registry, agent) {
  return `${registry.plugin.name}:${agent}`;
}

function variantTierLabel(role, variant) {
  if (variant.tier !== null && variant.tier !== undefined) return String(variant.tier).toUpperCase();
  return role.main ? "main" : "all";
}

export function renderAgentTable(registry, roles) {
  const rows = [
    ["Role", "Tier", "Agent", "Model", "Effort"],
    ["---", "---", "---", "---", "---"]
  ];
  for (const role of roles) {
    for (const variant of role.variants) {
      rows.push([role.name, variantTierLabel(role, variant), agentName(registry, variant.agent), variant.model, variant.effort]);
    }
  }
  return rows.map((cells) => `| ${cells.map(escapeCell).join(" | ")} |`).join("\n");
}

export function placeholderValues(registry, roles, libraryDir, setupNotes = EVERYTHING_INSTALLED) {
  const context = registry.context;
  return {
    agentTable: renderAgentTable(registry, roles),
    setupNotes,
    warnTokens: formatTokens(context.warnTokens),
    handoffTokens: formatTokens(context.handoffTokens),
    compactTokens: formatTokens(context.compactTokens),
    windowTokens: formatTokens(context.window),
    keepwarmMinutes: String(context.keepwarmMinutes),
    keepwarmShortMinutes: String(context.keepwarmShortMinutes),
    keepwarmShortMaxMinutes: String(context.keepwarmShortMaxMinutes),
    bufferStepTokens: formatTokens(context.bufferStepTokens),
    overEveryCalls: String(context.overEveryCalls),
    libraryDir
  };
}

export function renderPlaceholders(text, values, where, { strict = true } = {}) {
  return text.replace(PLACEHOLDER_PATTERN, (whole, name) => {
    if (Object.hasOwn(values, name)) return values[name];
    if (!strict) return whole;
    const hint = SKILL_ONLY_PLACEHOLDERS.includes(name) ? " (it works only inside a skill body)" : "";
    throw new Error(`${where}: unknown placeholder ${whole}${hint}`);
  });
}

function yamlScalar(value) {
  const text = String(value);
  if (PLAIN_YAML.test(text) && !YAML_KEYWORDS.test(text) && !/^[0-9.+-]/.test(text) && !text.endsWith(" ")) return text;
  return JSON.stringify(text);
}

export function renderFrontmatter(entries) {
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value)) {
      lines.push(`${key}:`);
      for (const [name, inner] of Object.entries(value)) lines.push(`  ${name}: ${yamlScalar(inner)}`);
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function modelLabel(registry, model) {
  const entry = registry.models?.[model];
  return typeof entry?.label === "string" ? entry.label : model;
}

export function agentDescription(registry, role, variant) {
  const base = String(role.description ?? "").trim();
  if (role.main) return base;
  if (variant.tier === null) return `${base} Every tier: ${modelLabel(registry, variant.model)}, ${variant.effort} effort.`;
  return `${base} Tier ${variant.tier.toUpperCase()}: ${modelLabel(registry, variant.model)}, ${variant.effort} effort.`;
}

function attribute(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function withNewline(text) {
  return `${text.replace(/\s+$/, "")}\n`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function selectionSets(skills, selection) {
  const chosen = selection === undefined || selection === null ? defaultSelection(skills) : selection;
  if (!isPlainObject(chosen)) throw new Error("compile: selection must be an object of role name to skill names");
  const known = new Set(skills.map((skill) => skill.name));
  const sets = {};
  for (const role of ROLES) {
    const list = chosen[role] === undefined ? [] : chosen[role];
    if (!Array.isArray(list)) throw new Error(`compile: selection.${role} must be a list of skill names`);
    for (const name of list) {
      if (!known.has(name)) throw new Error(`compile: selection.${role} names unknown skill ${name}`);
    }
    sets[role] = new Set(list);
  }
  return sets;
}

function skillMdPath(libraryDir, skill) {
  return `${libraryDir}/${skill.name}/${SKILL_FILE}`;
}

function skillValues(values, libraryDir, skill) {
  return { ...values, skillDir: `${libraryDir}/${skill.name}` };
}

function libraryIndex(others, libraryDir) {
  const lines = ["## Skill library", ""];
  if (others.length === 0) {
    lines.push("Every installed skill is already loaded above.");
    return lines.join("\n");
  }
  lines.push("These installed skills are not loaded above. When the work needs one, Read its SKILL.md first.", "");
  for (const skill of others) {
    lines.push(`- ${skill.name}: ${skill.description}`);
    lines.push(`  ${skillMdPath(libraryDir, skill)}`);
  }
  return lines.join("\n");
}

function composeBody({ role, sources, inline, others, values, libraryDir }) {
  const persona = sources.personas?.[role.name];
  if (typeof persona !== "string") throw new Error(`compile: the body of role ${role.name} (${role.body}) is missing`);
  const parts = [renderPlaceholders(persona, values, `${role.body}`).trim()];
  if (!role.main) {
    if (typeof sources.workerBlock !== "string") throw new Error("compile: the worker block is missing");
    parts.push(renderPlaceholders(sources.workerBlock, values, sources.registry.blocks.worker).trim());
  }
  for (const skill of inline) {
    const body = renderPlaceholders(skill.body, skillValues(values, libraryDir, skill), `${skill.label ?? skill.name}/${SKILL_FILE}`).trim();
    parts.push(`<wf-skill name="${attribute(skill.name)}" path="${attribute(skillMdPath(libraryDir, skill))}">\n${body}\n</wf-skill>`);
  }
  parts.push(libraryIndex(others, libraryDir));
  return withNewline(parts.filter((part) => part !== "").join("\n\n"));
}

function relativeInside(api, from, to, label) {
  const rel = api.relative(from, to);
  if (rel === "" || rel.startsWith("..") || api.isAbsolute(rel)) throw new Error(`compile: ${label} must be inside configHome`);
  return toPosix(rel);
}

function checkTarget(target, label) {
  const text = toPosix(target ?? "");
  if (text === "" || text.startsWith("/") || /^[A-Za-z]:/.test(text) || text.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`compile: ${label} target ${JSON.stringify(target)} must be a plain relative path`);
  }
  return text;
}

function shQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

function shWord(text) {
  return SAFE_WORD.test(text) ? text : shQuote(text);
}

function cmdQuote(text) {
  const value = String(text);
  if (value.includes('"')) throw new Error(`compile: ${JSON.stringify(value)} cannot be quoted for cmd.exe`);
  return `"${value.replace(/%/g, "%%")}"`;
}

function cmdWord(text) {
  return SAFE_WORD.test(text) ? text : cmdQuote(text);
}

function crlf(lines) {
  return `${lines.join("\r\n")}\r\n`;
}

function launcherEnv(registry) {
  const env = isPlainObject(registry.launcher?.env) ? registry.launcher.env : {};
  return Object.entries(env).map(([name, value]) => [name, String(value)]);
}

export function posixLauncher(registry, { pluginDir, settingsFile }) {
  const lines = ["#!/bin/sh"];
  for (const [name, value] of launcherEnv(registry)) lines.push(`export ${name}=${shQuote(value)}`);
  lines.push(
    `exec ${LAUNCHER_COMMAND} --plugin-dir ${shQuote(pluginDir)} --settings ${shQuote(settingsFile)} --agent ${shWord(registry.launcher.agent)} "$@"`
  );
  return `${lines.join("\n")}\n`;
}

export function cmdLauncher(registry, { pluginDir, settingsFile }) {
  const lines = ["@echo off", "setlocal"];
  for (const [name, value] of launcherEnv(registry)) {
    if (value.includes('"')) throw new Error(`compile: launcher env ${name} cannot hold a double quote`);
    lines.push(`set "${name}=${value.replace(/%/g, "%%")}"`);
  }
  lines.push(`${LAUNCHER_COMMAND} --plugin-dir ${cmdQuote(pluginDir)} --settings ${cmdQuote(settingsFile)} --agent ${cmdWord(registry.launcher.agent)} %*`);
  return crlf(lines);
}

export function posixWrapper(nodePath, scriptPath) {
  return `#!/bin/sh\nexec ${shQuote(nodePath)} ${shQuote(scriptPath)} "$@"\n`;
}

export function cmdWrapper(nodePath, scriptPath) {
  return crlf(["@echo off", `${cmdQuote(nodePath)} ${cmdQuote(scriptPath)} %*`]);
}

export function hooksConfig({ nodePath, guardPath, contextPath, titlePath, platform = "linux" }) {
  const handler = (args, filter, onFailure, timeout = HOOK_TIMEOUT_SECONDS) => {
    const out = { type: "command", command: nodePath, args };
    if (filter !== undefined) out.if = filter;
    out.timeout = timeout;
    if (onFailure !== undefined) out.onFailure = onFailure;
    return out;
  };
  const guard = [
    { matcher: "Bash", hooks: GUARD_FILTERS.map((filter) => handler([guardPath], filter, "block")) },
    { matcher: "Monitor", hooks: [handler([guardPath], undefined, "block")] }
  ];
  if (platform === "win32") guard.push({ matcher: "PowerShell", hooks: POWERSHELL_GUARD_FILTERS.map((filter) => handler([guardPath], filter, "block")) });
  return {
    hooks: {
      PreToolUse: guard,
      PostToolUse: [{ matcher: "*", hooks: [handler([contextPath])] }, { matcher: "Write", hooks: [handler([titlePath])] }],
      SessionStart: [{ matcher: "clear", hooks: [handler([titlePath])] }],
      UserPromptSubmit: [{ hooks: [handler([titlePath], undefined, undefined, TITLE_HOOK_TIMEOUT_SECONDS)] }],
      PreCompact: [{ hooks: [handler([contextPath, "precompact"])] }]
    },
    modules: [`./${COMPACT_SCRIPT.split("/").pop()}`]
  };
}

export function hookRuntimeConfig(registry, stateDir) {
  const context = registry.context;
  const out = {};
  for (const key of CONFIG_KEYS) out[key] = context[key];
  out.stateDir = stateDir;
  for (const key of KEEPWARM_KEYS) out[key] = context[key];
  const cacheTtl = {};
  for (const [name, role] of Object.entries(isPlainObject(registry.roles) ? registry.roles : {})) {
    if (isPlainObject(role) && role.cacheTtl !== undefined) cacheTtl[name] = role.cacheTtl;
  }
  out.cacheTtl = cacheTtl;
  return out;
}

function checkPaths(paths) {
  if (!isPlainObject(paths)) throw new Error("compile: paths is required");
  for (const key of ["configHome", "appDir", "pluginDir", "stateDir", "launcherDir"]) {
    if (typeof paths[key] !== "string" || paths[key] === "") throw new Error(`compile: paths.${key} must be an absolute path`);
  }
}

function cacheTtlFields(role, agent) {
  const variant = role.variants.find((item) => item.agent === agent);
  return variant?.cacheTtl === undefined ? {} : { cacheTtl: variant.cacheTtl };
}

export function installedRoles(roles, setup) {
  return roles
    .map((role) => ({
      ...role,
      variants: setup.variants
        .filter((variant) => variant.role === role.name)
        .map(({ agent, tier, model, effort, remappedFrom }) => ({ agent, tier, model, effort, ...cacheTtlFields(role, agent), ...(remappedFrom ? { remappedFrom } : {}) }))
    }))
    .filter((role) => role.variants.length > 0);
}

export function setupOf(sources, choices) {
  const registry = sources.registry;
  const roles = Array.isArray(sources.roles) ? sources.roles : normalizeRoles(registry);
  const model = installModel({ registry, roles });
  const chosen = choices === undefined || choices === null ? defaultChoices(model) : choices;
  try {
    validateChoices(model, chosen);
  } catch (error) {
    throw new Error(`compile: ${error.message}`);
  }
  return { model, setup: resolveSetup(model, chosen) };
}

export function compile(sources, { paths, nodePath, platform = process.platform, selection, choices } = {}) {
  checkPaths(paths);
  if (typeof nodePath !== "string" || nodePath === "") throw new Error("compile: nodePath is required");
  const registry = sources.registry;
  const windows = platform === "win32";
  const api = windows ? path.win32 : path.posix;
  const slashPath = windows ? toPosix : (text) => text;
  const { model, setup } = setupOf(sources, choices);
  const roles = installedRoles(Array.isArray(sources.roles) ? sources.roles : normalizeRoles(registry), setup);
  const skills = Array.isArray(sources.skills) ? sources.skills : [];
  const pluginRel = relativeInside(api, paths.configHome, paths.pluginDir, "paths.pluginDir");
  const appRel = relativeInside(api, paths.configHome, paths.appDir, "paths.appDir");
  const libraryDir = slashPath(api.join(paths.pluginDir, "library"));
  const values = placeholderValues(registry, roles, libraryDir, renderSetupNotes(setup, model));
  const chosen = selectionSets(skills, selection);
  const files = [];
  const agents = [];
  const add = (base, filePath, content, mode = CONFIG_MODE) => files.push({ base, path: filePath, content, mode });

  for (const role of roles) {
    const roleSet = chosen[role.name] ?? new Set();
    const inline = skills.filter((skill) => skill.required.includes(role.name) || roleSet.has(skill.name));
    const others = skills.filter((skill) => !inline.includes(skill));
    const body = composeBody({ role, sources, inline, others, values, libraryDir });
    for (const variant of role.variants) {
      const frontmatter = renderFrontmatter([
        ["name", variant.agent],
        ["description", agentDescription(registry, role, variant)],
        ["tools", role.tools === null ? undefined : role.tools.join(", ")],
        ["model", variant.model],
        ["effort", variant.effort],
        ["experimental", variant.cacheTtl === undefined ? undefined : { cacheTtl: variant.cacheTtl }],
        ["color", role.color]
      ]);
      add("config", `${pluginRel}/agents/${variant.agent}.md`, `${frontmatter}\n${body}`);
      agents.push({
        name: variant.agent,
        agent: agentName(registry, variant.agent),
        role: role.name,
        tier: variant.tier,
        model: variant.model,
        effort: variant.effort,
        ...(variant.remappedFrom ? { remappedFrom: variant.remappedFrom } : {})
      });
    }
  }

  const plugin = registry.plugin;
  add("config", `${pluginRel}/.claude-plugin/plugin.json`, json({ name: plugin.name, version: plugin.version, description: plugin.description, ...(isPlainObject(plugin.author) ? { author: plugin.author } : {}) }));

  for (const skill of skills) {
    if (skill.binary?.length > 0) throw new Error(`compile: skill ${skill.name} holds a file that is not text: ${skill.binary[0]}`);
    const own = skillValues(values, libraryDir, skill);
    for (const rel of skill.files) {
      const text = skill.contents?.[rel] ?? normalizeText(fs.readFileSync(path.join(skill.dir, ...rel.split("/"))));
      const where = `${skill.label ?? skill.name}/${rel}`;
      const content = rel === SKILL_FILE ? renderPlaceholders(text, own, where) : renderPlaceholders(text, own, where, { strict: false });
      add("config", `${pluginRel}/library/${skill.name}/${rel}`, withNewline(content));
    }
  }

  const guardPath = api.join(paths.pluginDir, ...GUARD_SCRIPT.split("/"));
  const contextPath = api.join(paths.pluginDir, ...CONTEXT_SCRIPT.split("/"));
  const titlePath = api.join(paths.pluginDir, ...TITLE_SCRIPT.split("/"));
  add("config", `${pluginRel}/hooks/hooks.json`, json(hooksConfig({ nodePath, guardPath, contextPath, titlePath, platform })));
  add("config", `${pluginRel}/hooks/config.json`, json(hookRuntimeConfig(registry, paths.stateDir)));

  for (const entry of listOf(sources.hookScripts)) {
    const target = checkTarget(entry.target, "hook script");
    if (typeof entry.text !== "string") throw new Error(`compile: hook script ${entry.source} is missing`);
    add("config", `${pluginRel}/${target}`, withNewline(entry.text));
  }

  for (const entry of listOf(sources.scripts)) {
    const target = checkTarget(entry.target, "script");
    if (typeof entry.text !== "string") throw new Error(`compile: script ${entry.source} is missing`);
    add("config", `${pluginRel}/${target}`, withNewline(entry.text));
    const name = path.posix.basename(target).replace(/\.m?js$/, "");
    const scriptPath = api.join(paths.pluginDir, ...target.split("/"));
    add("config", `${pluginRel}/bin/${name}`, posixWrapper(slashPath(nodePath), slashPath(scriptPath)), EXEC_MODE);
    if (windows) add("config", `${pluginRel}/bin/${name}.cmd`, cmdWrapper(nodePath, scriptPath), EXEC_MODE);
  }

  add("config", `${appRel}/${WF_SETTINGS_FILE}`, json(isPlainObject(registry.wfSettings) ? registry.wfSettings : {}));

  for (const rule of listOf(sources.rules)) {
    const target = checkTarget(rule.target, "rule");
    if (typeof rule.text !== "string") throw new Error(`compile: rule ${rule.source} is missing`);
    add("config", target, withNewline(rule.text));
  }

  const settingsFile = api.join(paths.appDir, WF_SETTINGS_FILE);
  const launcherName = registry.launcher.name;
  add("launcher", launcherName, posixLauncher(registry, { pluginDir: slashPath(paths.pluginDir), settingsFile: slashPath(settingsFile) }), EXEC_MODE);
  if (windows) add("launcher", `${launcherName}.cmd`, cmdLauncher(registry, { pluginDir: paths.pluginDir, settingsFile }), EXEC_MODE);

  files.sort((a, b) => compareText(a.base, b.base) || compareText(a.path, b.path));
  const seen = new Set();
  for (const file of files) {
    const key = `${file.base}:${file.path}`;
    if (seen.has(key)) throw new Error(`compile: two outputs share the path ${key}`);
    seen.add(key);
  }
  return { files, agents };
}
