import fs from "node:fs";
import path from "node:path";
import { ROLES, SKILL_FILE, compareText, isPlainObject, normalizeText, parseFrontmatter, validateSkill } from "./skills.mjs";
import { TOOL_FULL_NAME, TOOL_NAME } from "../hooks/compact.mjs";
import {
  COMPACT_SCRIPT,
  CONTEXT_SCRIPT,
  GUARD_SCRIPT,
  PLACEHOLDER_NAMES,
  PLACEHOLDER_PATTERN,
  REGISTRY_FILE,
  SKILL_ONLY_PLACEHOLDERS,
  TITLE_SCRIPT,
  compile,
  normalizeRoles
} from "./compile.mjs";
import { defaultSelection, installModel } from "./select.mjs";

export const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const COLORS = Object.freeze(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]);
export const KNOWN_TOOLS = Object.freeze([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "ListAgents",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "Read",
  "SendMessage",
  "Skill",
  "Task",
  "TaskStop",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write"
]);
export const WORKER_FORBIDDEN_TOOLS = Object.freeze(["Agent", "Task", "Skill", "SendMessage", "ListAgents", "AskUserQuestion", "Workflow", "TaskStop"]);
export const AGENT_FRONTMATTER_KEYS = Object.freeze(["name", "description", "tools", "model", "effort", "experimental", "color"]);
export const CACHE_TTLS = Object.freeze(["5m", "1h"]);
export const REQUIRED_DENY = Object.freeze(["Agent(model:*)", "Agent(effort:*)"]);
export const UNUSED_TOOLS_DENY = Object.freeze(["Artifact", "Workflow", "ScheduleWakeup", "SendFeedback", "ReportFindings", "ListAgents"]);
export const FORBIDDEN_SETTING = "autoCompactWindow";
export const FORBIDDEN_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
export const PCT_ENV = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
export const OUTPUT_RESERVE_TOKENS = 20000;
export const PCT_TOLERANCE_TOKENS = 1000;
export const LAUNCHER_FORBIDDEN_ENV = Object.freeze(["CLAUDE_CONFIG_DIR", "HOME"]);
export const SELF_EXTENSIONS = Object.freeze([".md", ".mjs", ".js", ".json", ".yml", ".yaml", ".html", ".sh", ".cmd"]);
export const SELF_CODE_EXTENSIONS = Object.freeze([".mjs", ".js"]);
export const SELF_SKIP_DIRS = Object.freeze([".git", ".work", "node_modules", "probe-output"]);
export const FORBIDDEN_DASHES = Object.freeze([0x2012, 0x2013, 0x2014, 0x2015]);
export const AGENT_DESCRIPTION_MAX = 400;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ENV_BAD_VALUE = /["'`%!$\\\u0000-\u001f\u007f]/;
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLDER_NAME = /^[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PERCENT = /^\d+(?:\.\d+)?$/;
const HOOK_TARGET = /^hooks\/[a-z0-9-]+\.mjs$/;
const SCRIPT_TARGET = /^scripts\/[a-z0-9-]+\.mjs$/;
const RULE_TARGET = /^rules\/[a-z0-9-]+\.md$/;
const LAUNCHER_NAME = /^[A-Za-z0-9_-]+$/;
const DASH_FIX = "use a comma, a colon or a hyphen instead";

function finding(level, where, message) {
  return { level, where, message };
}

function codePointLabel(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const strList = { type: "array", items: str };
const req = (spec) => ({ ...spec, required: true });
const obj = (props) => ({ type: "object", props });
const map = (values, keyPattern, keyHint) => ({ type: "object", values, keyPattern, keyHint });

const FILE_ENTRY = obj({ source: req(str), target: req(str) });
const TIER = obj({ model: req(str), effort: req(str) });
const ROLE = obj({
  main: bool,
  single: bool,
  body: req(str),
  description: req(str),
  color: req(str),
  tools: strList,
  model: str,
  effort: str,
  cacheTtl: str,
  tiers: map(TIER, /^t[1-5]$/, "t1, t2, t3, t4 or t5")
});

export const REGISTRY_SCHEMA = obj({
  schemaVersion: req({ type: "integer", enum: [2] }),
  plugin: req(obj({ name: req(str), version: req(str), description: req(str), author: obj({ name: req(str) }) })),
  appDir: req(str),
  claude: req(obj({ minVersion: req(str) })),
  node: req(obj({ minMajor: req(int) })),
  models: req(map(obj({ label: req(str), window: req(int) }), /^claude-[a-z0-9-]+$/, "a full model id such as claude-sonnet-5-5")),
  install: req(obj({ models: req(strList), requiredRoles: req(strList) })),
  context: req(
    obj({
      window: req(int),
      warnTokens: req(int),
      handoffTokens: req(int),
      compactTokens: req(int),
      autoCompactPctOverride: req(str),
      bufferStepTokens: req(int),
      overEveryCalls: req(int),
      keepwarmMinutes: req(int),
      keepwarmPollSeconds: req(int),
      keepwarmShortMinutes: req(int),
      keepwarmShortMaxMinutes: req(int)
    })
  ),
  roles: req(map(ROLE)),
  blocks: req(obj({ worker: req(str) })),
  rules: req({ type: "array", items: FILE_ENTRY }),
  hookScripts: req({ type: "array", items: FILE_ENTRY }),
  scripts: req({ type: "array", items: FILE_ENTRY }),
  launcher: req(obj({ name: req(str), agent: req(str), env: req(map(str)) })),
  wfSettings: req({ type: "object" })
});

function typeMatches(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  return false;
}

function article(type) {
  if (type === "integer") return "an integer";
  if (type === "array") return "a list";
  if (type === "object") return "an object";
  return `a ${type}`;
}

function walkSchema(value, spec, where, out) {
  const label = where || "<root>";
  if (!typeMatches(value, spec.type)) {
    out.push(finding("error", REGISTRY_FILE, `${label} must be ${article(spec.type)}`));
    return;
  }
  if (spec.enum && !spec.enum.includes(value)) {
    out.push(finding("error", REGISTRY_FILE, `${label} must be one of ${spec.enum.join(", ")}, found ${JSON.stringify(value)}`));
  }
  if (Array.isArray(value) && spec.items) {
    value.forEach((item, index) => walkSchema(item, spec.items, `${label}[${index}]`, out));
  }
  if (spec.type === "object" && spec.values) {
    for (const [key, child] of Object.entries(value)) {
      if (spec.keyPattern && !spec.keyPattern.test(key)) {
        out.push(finding("error", REGISTRY_FILE, `${label}.${key}: unknown key; use ${spec.keyHint}`));
      }
      walkSchema(child, spec.values, `${label}.${key}`, out);
    }
  }
  if (spec.type === "object" && spec.props) {
    const prefix = where ? `${where}.` : "";
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(spec.props, key)) {
        out.push(finding("error", REGISTRY_FILE, `unknown key ${prefix}${key}; remove it or fix the spelling (known: ${Object.keys(spec.props).join(", ")})`));
      }
    }
    for (const [key, child] of Object.entries(spec.props)) {
      if (!Object.hasOwn(value, key)) {
        if (child.required) out.push(finding("error", REGISTRY_FILE, `missing required key ${prefix}${key}`));
        continue;
      }
      walkSchema(value[key], child, `${prefix}${key}`, out);
    }
  }
}

export function lintRegistrySchema(registry) {
  const out = [];
  walkSchema(registry, REGISTRY_SCHEMA, "", out);
  return out;
}

function searchTokens(value, where, tokens, out) {
  if (typeof value === "string") {
    for (const token of tokens) {
      if (value.includes(token)) out.push({ where, token });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => searchTokens(item, `${where}[${index}]`, tokens, out));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const at = where ? `${where}.${key}` : key;
      for (const token of tokens) {
        if (key.includes(token)) out.push({ where: at, token });
      }
      searchTokens(child, at, tokens, out);
    }
  }
}

function windowFindings(registry) {
  const out = [];
  const hits = [];
  searchTokens(registry, "", [FORBIDDEN_SETTING, FORBIDDEN_ENV], hits);
  for (const hit of hits) {
    out.push(
      finding(
        "error",
        REGISTRY_FILE,
        `${hit.where} uses ${hit.token}, which redefines the context window so that 100 percent would no longer mean the full window (D106); remove it and use ${PCT_ENV} for the trigger`
      )
    );
  }
  return out;
}

function checkContext(registry, out) {
  const context = registry.context;
  if (!isPlainObject(context)) return;
  const numbers = ["window", "warnTokens", "handoffTokens", "compactTokens", "bufferStepTokens", "overEveryCalls", "keepwarmMinutes", "keepwarmPollSeconds", "keepwarmShortMinutes", "keepwarmShortMaxMinutes"];
  if (!numbers.every((key) => Number.isInteger(context[key]))) return;
  if (!(context.warnTokens > 0 && context.warnTokens < context.handoffTokens && context.handoffTokens < context.compactTokens && context.compactTokens < context.window)) {
    out.push(finding("error", REGISTRY_FILE, "context needs 0 < warnTokens < handoffTokens < compactTokens < window"));
  }
  if (context.bufferStepTokens <= 0 || context.bufferStepTokens >= context.handoffTokens - context.warnTokens) {
    out.push(finding("error", REGISTRY_FILE, "context.bufferStepTokens must be above 0 and below handoffTokens minus warnTokens"));
  }
  if (context.overEveryCalls < 1) out.push(finding("error", REGISTRY_FILE, "context.overEveryCalls must be at least 1"));
  if (context.keepwarmMinutes < 1 || context.keepwarmMinutes >= 60) {
    out.push(finding("error", REGISTRY_FILE, "context.keepwarmMinutes must be between 1 and 59: the 1 hour cache expires at 60"));
  }
  if (context.keepwarmPollSeconds < 1 || context.keepwarmPollSeconds >= context.keepwarmMinutes * 60) {
    out.push(finding("error", REGISTRY_FILE, "context.keepwarmPollSeconds must be at least 1 and shorter than keepwarmMinutes"));
  }
  if (context.keepwarmShortMinutes < 1 || context.keepwarmShortMinutes >= 5) {
    out.push(finding("error", REGISTRY_FILE, "context.keepwarmShortMinutes must be between 1 and 4: the 5 minute cache expires at 5"));
  }
  if (context.keepwarmShortMaxMinutes <= context.keepwarmShortMinutes) {
    out.push(finding("error", REGISTRY_FILE, "context.keepwarmShortMaxMinutes must be above keepwarmShortMinutes"));
  }
  const pct = context.autoCompactPctOverride;
  if (typeof pct !== "string") return;
  if (!PERCENT.test(pct) || !(Number(pct) > 0 && Number(pct) < 100)) {
    out.push(finding("error", REGISTRY_FILE, `context.autoCompactPctOverride ${JSON.stringify(pct)} must be a percent between 0 and 100`));
    return;
  }
  const trigger = Math.round((Number(pct) / 100) * (context.window - OUTPUT_RESERVE_TOKENS));
  if (Math.abs(trigger - context.compactTokens) > PCT_TOLERANCE_TOKENS) {
    out.push(
      finding(
        "error",
        REGISTRY_FILE,
        `context.autoCompactPctOverride ${pct} puts the compaction trigger at ${trigger} tokens (percent of the window minus the ${OUTPUT_RESERVE_TOKENS} output reserve), not at compactTokens ${context.compactTokens}`
      )
    );
  }
}

function checkModels(registry, out) {
  const models = isPlainObject(registry.models) ? registry.models : {};
  const window = registry.context?.window;
  for (const [id, model] of Object.entries(models)) {
    if (Number.isInteger(window) && isPlainObject(model) && Number.isInteger(model.window) && model.window !== window) {
      out.push(finding("error", REGISTRY_FILE, `models.${id}.window ${model.window} differs from context.window ${window}; the context zones assume the full window`));
    }
  }
}

function checkTools(role, where, out) {
  const seen = new Set();
  for (const tool of role.tools) {
    const name = tool.replace(/\(.*$/, "").trim();
    if (!KNOWN_TOOLS.includes(name)) out.push(finding("error", REGISTRY_FILE, `${where}.tools: unknown tool ${tool}; use ${KNOWN_TOOLS.join(", ")}`));
    if (WORKER_FORBIDDEN_TOOLS.includes(name)) out.push(finding("error", REGISTRY_FILE, `${where}.tools: workers may not have ${name}`));
    if (seen.has(name)) out.push(finding("error", REGISTRY_FILE, `${where}.tools: ${name} is listed twice`));
    seen.add(name);
  }
}

function checkRoles(registry, out) {
  if (!isPlainObject(registry.roles)) return [];
  const roles = normalizeRoles(registry);
  const names = roles.map((role) => role.name);
  for (const name of names) {
    if (!ROLES.includes(name)) out.push(finding("error", REGISTRY_FILE, `roles.${name}: unknown role; wf roles are ${ROLES.join(", ")}`));
  }
  for (const name of ROLES) {
    if (!names.includes(name)) out.push(finding("error", REGISTRY_FILE, `roles.${name} is missing`));
  }
  const mains = roles.filter((role) => role.main);
  if (mains.length !== 1) out.push(finding("error", REGISTRY_FILE, `exactly one role must have main: true, found ${mains.length}`));
  const models = isPlainObject(registry.models) ? registry.models : {};
  for (const role of roles) {
    const raw = registry.roles[role.name];
    const where = `roles.${role.name}`;
    if (role.main) {
      if (raw.single === true) out.push(finding("error", REGISTRY_FILE, `${where}.single: a role is either main or single, not both`));
      for (const key of ["tools", "tiers"]) {
        if (raw[key] !== undefined) out.push(finding("error", REGISTRY_FILE, `${where}.${key}: the main role takes no ${key} (it keeps every tool, D103)`));
      }
      for (const key of ["model", "effort"]) {
        if (raw[key] === undefined) out.push(finding("error", REGISTRY_FILE, `${where}.${key} is required for the main role`));
      }
    } else if (role.single) {
      if (raw.tiers !== undefined) out.push(finding("error", REGISTRY_FILE, `${where}.tiers: a single role has one agent for every tier; set model and effort on the role`));
      for (const key of ["model", "effort"]) {
        if (raw[key] === undefined) out.push(finding("error", REGISTRY_FILE, `${where}.${key} is required for a single role`));
      }
      if (raw.tools !== undefined) {
        if (!Array.isArray(raw.tools) || raw.tools.length === 0) out.push(finding("error", REGISTRY_FILE, `${where}.tools: leave tools out to give the agent every tool, or list at least one`));
        else checkTools(role, where, out);
      }
    } else {
      for (const key of ["model", "effort"]) {
        if (raw[key] !== undefined) out.push(finding("error", REGISTRY_FILE, `${where}.${key}: a worker sets model and effort per tier, under tiers`));
      }
      if (!Array.isArray(raw.tools) || raw.tools.length === 0) out.push(finding("error", REGISTRY_FILE, `${where}.tools: a worker needs a tools list`));
      else checkTools(role, where, out);
      if (role.variants.length === 0) out.push(finding("error", REGISTRY_FILE, `${where}.tiers: a worker needs at least one tier`));
    }
    if (role.main && raw.cacheTtl !== undefined) {
      out.push(finding("error", REGISTRY_FILE, `${where}.cacheTtl: the main role keeps the default cache of the main thread`));
    }
    if (!role.main && !CACHE_TTLS.includes(raw.cacheTtl)) {
      out.push(finding("error", REGISTRY_FILE, `${where}.cacheTtl must be "5m" or "1h"`));
    }
    if (typeof role.color === "string" && !COLORS.includes(role.color)) {
      out.push(finding("error", REGISTRY_FILE, `${where}.color ${role.color} is not a Claude Code agent color; use ${COLORS.join(", ")}`));
    }
    if (typeof role.description === "string") {
      if (role.description.trim() === "") out.push(finding("error", REGISTRY_FILE, `${where}.description is empty`));
      if (role.description.length > AGENT_DESCRIPTION_MAX) {
        out.push(finding("warning", REGISTRY_FILE, `${where}.description has ${role.description.length} characters; keep it under ${AGENT_DESCRIPTION_MAX}`));
      }
    }
    if (typeof role.body === "string" && !role.body.endsWith(".md")) out.push(finding("error", REGISTRY_FILE, `${where}.body must be a .md file`));
    for (const variant of role.variants) {
      const at = variant.tier === null ? where : `${where}.tiers.${variant.tier}`;
      if (typeof variant.model === "string" && !Object.hasOwn(models, variant.model)) {
        out.push(finding("error", REGISTRY_FILE, `${at}.model ${variant.model} is not in models; use ${Object.keys(models).join(", ")}`));
      }
      if (typeof variant.effort === "string" && !EFFORTS.includes(variant.effort)) {
        out.push(finding("error", REGISTRY_FILE, `${at}.effort ${variant.effort} must be one of ${EFFORTS.join(", ")}`));
      }
    }
  }
  return roles;
}

export const MAIN_PLACEHOLDERS = Object.freeze(["agentTable", "setupNotes"]);

function checkInstall(registry, roles, out) {
  const install = registry.install;
  if (!isPlainObject(install)) return;
  const models = isPlainObject(registry.models) ? Object.keys(registry.models) : [];
  if (Array.isArray(install.models)) {
    const seen = new Set();
    for (const id of install.models) {
      if (typeof id !== "string") continue;
      if (!models.includes(id)) out.push(finding("error", REGISTRY_FILE, `install.models: ${id} is not in models; use ${models.join(", ")}`));
      if (seen.has(id)) out.push(finding("error", REGISTRY_FILE, `install.models: ${id} is listed twice`));
      seen.add(id);
    }
    for (const id of models) {
      if (!seen.has(id)) out.push(finding("error", REGISTRY_FILE, `install.models must list every model, strongest first; ${id} is missing`));
    }
  }
  if (Array.isArray(install.requiredRoles)) {
    const workers = roles.filter((role) => !role.main);
    const tiers = installModel({ registry, roles }).tiers;
    for (const name of install.requiredRoles) {
      if (typeof name !== "string") continue;
      const role = workers.find((item) => item.name === name);
      if (!role) {
        out.push(finding("error", REGISTRY_FILE, `install.requiredRoles: ${name} is not a worker role; use ${workers.map((item) => item.name).join(", ")}`));
        continue;
      }
      if (role.single) continue;
      const missing = tiers.filter((tier) => !role.variants.some((variant) => variant.tier === tier));
      if (missing.length > 0) out.push(finding("error", REGISTRY_FILE, `install.requiredRoles: ${name} has no ${missing.join(", ")} variant, so it cannot be needed by every tier`));
    }
  }
}

function checkFiles(registry, out) {
  const check = (list, key, pattern, hint) => {
    for (const [index, entry] of (Array.isArray(list) ? list : []).entries()) {
      if (!isPlainObject(entry) || typeof entry.target !== "string") continue;
      if (!pattern.test(entry.target)) out.push(finding("error", REGISTRY_FILE, `${key}[${index}].target ${entry.target} must look like ${hint}`));
    }
  };
  check(registry.rules, "rules", RULE_TARGET, "rules/<name>.md");
  check(registry.hookScripts, "hookScripts", HOOK_TARGET, "hooks/<name>.mjs (relative to the plugin folder)");
  check(registry.scripts, "scripts", SCRIPT_TARGET, "scripts/<name>.mjs (relative to the plugin folder)");
  const hookTargets = (Array.isArray(registry.hookScripts) ? registry.hookScripts : []).map((entry) => entry?.target);
  for (const needed of [GUARD_SCRIPT, CONTEXT_SCRIPT, COMPACT_SCRIPT, TITLE_SCRIPT]) {
    if (Array.isArray(registry.hookScripts) && !hookTargets.includes(needed)) {
      out.push(finding("error", REGISTRY_FILE, `hookScripts must install ${needed}: hooks.json runs it`));
    }
  }
  const seen = new Set();
  for (const key of ["rules", "hookScripts", "scripts"]) {
    for (const entry of Array.isArray(registry[key]) ? registry[key] : []) {
      if (!isPlainObject(entry) || typeof entry.target !== "string") continue;
      if (seen.has(entry.target)) out.push(finding("error", REGISTRY_FILE, `${key}: target ${entry.target} is used twice`));
      seen.add(entry.target);
    }
  }
}

function checkLauncher(registry, roles, out) {
  const launcher = registry.launcher;
  if (!isPlainObject(launcher)) return;
  if (typeof launcher.name === "string" && !LAUNCHER_NAME.test(launcher.name)) {
    out.push(finding("error", REGISTRY_FILE, `launcher.name ${launcher.name} must be letters, digits, hyphens or underscores`));
  }
  const main = roles.find((role) => role.main);
  if (main && typeof registry.plugin?.name === "string" && launcher.agent !== `${registry.plugin.name}:${main.name}`) {
    out.push(finding("error", REGISTRY_FILE, `launcher.agent must be ${registry.plugin.name}:${main.name}, the plugin's main agent`));
  }
  const env = isPlainObject(launcher.env) ? launcher.env : {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) out.push(finding("error", REGISTRY_FILE, `launcher.env.${name}: names are upper case letters, digits and underscores`));
    if (LAUNCHER_FORBIDDEN_ENV.includes(name)) {
      out.push(finding("error", REGISTRY_FILE, `launcher.env.${name} may not be set by the launcher`));
    }
    if (typeof value === "string" && ENV_BAD_VALUE.test(value)) {
      out.push(finding("error", REGISTRY_FILE, `launcher.env.${name}: the value may not hold quotes, %, !, $, backslashes or control characters`));
    }
  }
  const pct = registry.context?.autoCompactPctOverride;
  if (env[PCT_ENV] !== pct) {
    out.push(finding("error", REGISTRY_FILE, `launcher.env.${PCT_ENV} must equal context.autoCompactPctOverride (${JSON.stringify(pct)})`));
  }
}

export const OUTPUT_STYLE = "Concise";

function checkWfSettings(registry, out) {
  const settings = registry.wfSettings;
  if (!isPlainObject(settings)) return;
  if (settings.outputStyle !== undefined && (typeof settings.outputStyle !== "string" || settings.outputStyle.trim() === "")) {
    out.push(finding("error", REGISTRY_FILE, `wfSettings.outputStyle must name an output style such as ${OUTPUT_STYLE}`));
  }
  if (settings.ultracode !== false) {
    out.push(finding("error", REGISTRY_FILE, "wfSettings.ultracode must be false so a wf session never runs standing Workflow orchestration, even when the user settings turn ultracode on"));
  }
  const deny = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : [];
  for (const rule of REQUIRED_DENY) {
    if (!deny.includes(rule)) out.push(finding("error", REGISTRY_FILE, `wfSettings.permissions.deny must hold ${rule} so the pinned models and efforts hold`));
  }
  for (const tool of UNUSED_TOOLS_DENY) {
    if (!deny.includes(tool)) out.push(finding("error", REGISTRY_FILE, `wfSettings.permissions.deny must hold ${tool} so wf sessions do not load a tool wf never uses`));
  }
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  if (!allow.includes(TOOL_FULL_NAME)) {
    out.push(finding("error", REGISTRY_FILE, `wfSettings.permissions.allow must hold ${TOOL_FULL_NAME} so the orchestrator compacts without a permission prompt`));
  }
  if (deny.includes(TOOL_FULL_NAME)) out.push(finding("error", REGISTRY_FILE, `wfSettings.permissions.deny must not hold ${TOOL_FULL_NAME}: the orchestrator compacts through it`));
}

function checkPlugin(registry, out) {
  const plugin = registry.plugin;
  if (isPlainObject(plugin)) {
    if (typeof plugin.name === "string" && (!PLUGIN_NAME.test(plugin.name) || /^(claude|anthropic)/.test(plugin.name))) {
      out.push(finding("error", REGISTRY_FILE, `plugin.name ${plugin.name} must be kebab-case and must not start with claude or anthropic`));
    }
    if (typeof plugin.name === "string" && `mcp__${plugin.name}__${TOOL_NAME}` !== TOOL_FULL_NAME) {
      out.push(finding("error", REGISTRY_FILE, `plugin.name ${plugin.name} renames the compact tool to mcp__${plugin.name}__${TOOL_NAME}, but hooks/compact.mjs serves ${TOOL_FULL_NAME}`));
    }
    if (typeof plugin.version === "string" && !VERSION.test(plugin.version)) {
      out.push(finding("error", REGISTRY_FILE, `plugin.version ${plugin.version} must look like 2.0.0`));
    }
  }
  if (typeof registry.appDir === "string" && (!FOLDER_NAME.test(registry.appDir) || registry.appDir === "." || registry.appDir === "..")) {
    out.push(finding("error", REGISTRY_FILE, `appDir ${registry.appDir} must be one folder name`));
  }
  if (typeof registry.claude?.minVersion === "string" && !VERSION.test(registry.claude.minVersion)) {
    out.push(finding("error", REGISTRY_FILE, `claude.minVersion ${registry.claude.minVersion} must look like 2.1.312`));
  }
}

export function placeholderFindings(text, where, { skill = false } = {}) {
  const out = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    const line = lineNumberAt(text, match.index);
    if (!PLACEHOLDER_NAMES.includes(name)) {
      out.push(finding("error", where, `line ${line}: unknown placeholder ${match[0]}; known: ${PLACEHOLDER_NAMES.map((item) => `{{${item}}}`).join(", ")}`));
    } else if (!skill && SKILL_ONLY_PLACEHOLDERS.includes(name)) {
      out.push(finding("error", where, `line ${line}: ${match[0]} works only inside a skill body`));
    }
  }
  return out;
}

function tokenFindings(text, where, tokens = [FORBIDDEN_SETTING, FORBIDDEN_ENV]) {
  const out = [];
  for (const token of tokens) {
    let from = 0;
    while (true) {
      const at = text.indexOf(token, from);
      if (at < 0) break;
      out.push(
        finding("error", where, `line ${lineNumberAt(text, at)}: ${token} redefines the context window so that 100 percent would no longer mean the full window (D106); remove it`)
      );
      from = at + token.length;
    }
  }
  return out;
}

const IDENTIFIER_PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

export function referencePlaceholderFindings(text, where) {
  const out = [];
  for (const match of text.matchAll(IDENTIFIER_PLACEHOLDER)) {
    const name = match[1];
    if (PLACEHOLDER_NAMES.includes(name)) continue;
    const near = PLACEHOLDER_NAMES.find((known) => known.toLowerCase() === name.toLowerCase());
    if (near) out.push(finding("error", where, `line ${lineNumberAt(text, match.index)}: ${match[0]} is not expanded; did you mean {{${near}}}?`));
  }
  return out;
}

function checkTexts(sources, roles, out) {
  for (const role of roles) {
    const text = sources.personas?.[role.name];
    if (typeof text !== "string") continue;
    const where = String(role.body);
    if (role.main) {
      for (const name of MAIN_PLACEHOLDERS) {
        if (!text.includes(`{{${name}}}`)) out.push(finding("error", where, `the main persona must hold {{${name}}}: it tells the orchestrator which agents are installed and what replaces the missing ones`));
      }
    }
    if (text.trim() === "") out.push(finding("error", where, "the persona body is empty"));
    if (text.split("\n")[0].trim() === "---") out.push(finding("error", where, "persona files are body text only: remove the frontmatter, compile builds it from registry.json"));
    out.push(...placeholderFindings(text, where));
    out.push(...tokenFindings(text, where));
  }
  if (typeof sources.workerBlock === "string") {
    const where = String(sources.registry?.blocks?.worker ?? "worker block");
    if (sources.workerBlock.trim() === "") out.push(finding("error", where, "the worker block is empty"));
    out.push(...placeholderFindings(sources.workerBlock, where));
    out.push(...tokenFindings(sources.workerBlock, where));
  }
}

function checkSkills(sources, out) {
  for (const skill of Array.isArray(sources.skills) ? sources.skills : []) {
    out.push(...validateSkill(skill, ROLES));
    const root = skill.label ?? `skills/${skill.name}`;
    const parsed = parseFrontmatter(skill.contents?.[SKILL_FILE] ?? "");
    const bodyOffset = parsed.hasFrontmatter ? (skill.contents?.[SKILL_FILE] ?? "").split("\n").length - parsed.body.split("\n").length : 0;
    for (const item of placeholderFindings(parsed.body, `${root}/${SKILL_FILE}`, { skill: true })) {
      out.push({ ...item, message: item.message.replace(/^line (\d+)/, (whole, n) => `line ${Number(n) + bodyOffset}`) });
    }
    for (const [rel, text] of Object.entries(skill.contents ?? {})) {
      out.push(...tokenFindings(text, `${root}/${rel}`));
      if (rel !== SKILL_FILE) out.push(...referencePlaceholderFindings(text, `${root}/${rel}`));
    }
  }
}

function lintPaths() {
  const base = path.posix.join("/", "wf-lint", "config");
  const appDir = path.posix.join(base, "ai-agents-setup");
  return {
    configHome: base,
    appDir,
    pluginDir: path.posix.join(appDir, "plugin"),
    stateDir: path.posix.join(appDir, "state"),
    launcherDir: path.posix.join("/", "wf-lint", "bin")
  };
}

export function reducedChoices(sources) {
  const roles = Array.isArray(sources.roles) ? sources.roles : normalizeRoles(sources.registry);
  const model = installModel({ registry: sources.registry, roles });
  if (model.tiers.length === 0 || model.models.length === 0) return null;
  return { tiers: [model.tiers[0]], roles: [...model.required], models: [model.models[model.models.length - 1]] };
}

function compiledAgentFindings(sources, choices, label, out) {
  let result;
  try {
    result = compile(sources, {
      paths: lintPaths(),
      nodePath: "/wf-lint/node",
      platform: "linux",
      selection: defaultSelection(Array.isArray(sources.skills) ? sources.skills : []),
      ...(choices ? { choices } : {})
    });
  } catch (error) {
    out.push(finding("error", label, error.message));
    return false;
  }
  for (const file of result.files) {
    if (!/\/agents\/[^/]+\.md$/.test(file.path)) continue;
    const parsed = parseFrontmatter(file.content);
    const where = `compiled ${path.posix.basename(file.path)}`;
    for (const error of parsed.errors) out.push(finding("error", where, `frontmatter ${error}`));
    for (const key of Object.keys(parsed.data)) {
      if (!AGENT_FRONTMATTER_KEYS.includes(key)) out.push(finding("error", where, `frontmatter key ${key} is not allowed in wf agents`));
    }
    if (parsed.data.name !== path.posix.basename(file.path, ".md")) out.push(finding("error", where, "frontmatter name differs from the file name"));
    const role = path.posix.basename(file.path, ".md").replace(/-t\d+$/, "");
    const expected = sources.registry.roles?.[role]?.cacheTtl;
    if (expected === undefined) {
      if (Object.hasOwn(parsed.data, "experimental")) out.push(finding("error", where, `frontmatter experimental is not allowed in ${role}, which has no cacheTtl in the registry`));
    } else if (parsed.data.experimental?.cacheTtl !== expected) {
      out.push(finding("error", where, `frontmatter experimental.cacheTtl ${JSON.stringify(parsed.data.experimental?.cacheTtl ?? null)} differs from roles.${role}.cacheTtl ${JSON.stringify(expected)}`));
    }
    for (const match of file.content.matchAll(PLACEHOLDER_PATTERN)) {
      if (PLACEHOLDER_NAMES.includes(match[1])) out.push(finding("error", where, `placeholder ${match[0]} was left unresolved`));
    }
  }
  return true;
}

function checkCompiled(sources, out) {
  if (!compiledAgentFindings(sources, null, "compile", out)) return;
  const reduced = reducedChoices(sources);
  if (reduced) compiledAgentFindings(sources, reduced, "compile (smallest setup)", out);
}

export function lintSources(sources) {
  const out = [];
  for (const problem of Array.isArray(sources?.problems) ? sources.problems : []) out.push({ ...problem });
  const registry = sources?.registry;
  if (!isPlainObject(registry)) {
    out.push(finding("error", REGISTRY_FILE, "registry.json must hold a JSON object"));
    return out;
  }
  out.push(...lintRegistrySchema(registry));
  out.push(...windowFindings(registry));
  checkPlugin(registry, out);
  checkContext(registry, out);
  checkModels(registry, out);
  const roles = checkRoles(registry, out);
  checkFiles(registry, out);
  checkLauncher(registry, roles, out);
  checkInstall(registry, roles, out);
  checkWfSettings(registry, out);
  checkTexts(sources, roles, out);
  checkSkills(sources, out);
  if (!out.some((item) => item.level === "error")) checkCompiled(sources, out);
  return out;
}

const REGEX_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

export function findComments(source) {
  const text = normalizeText(source);
  const n = text.length;
  const found = [];
  let i = 0;
  let prev = "";

  const lineEnd = (from) => {
    const index = text.indexOf("\n", from);
    return index < 0 ? n : index;
  };

  const skipQuoted = (quote) => {
    i += 1;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      i += 1;
      if (c === quote || c === "\n") return;
    }
  };

  const skipRegex = () => {
    i += 1;
    let inClass = false;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") return;
      i += 1;
      if (inClass) {
        if (c === "]") inClass = false;
        continue;
      }
      if (c === "[") {
        inClass = true;
        continue;
      }
      if (c === "/") break;
    }
    while (i < n && /[A-Za-z]/.test(text[i])) i += 1;
  };

  const regexAllowed = () => {
    if (prev === "") return true;
    if (prev === "value") return false;
    if (prev.startsWith("word:")) return REGEX_KEYWORDS.has(prev.slice(5));
    return prev !== ")" && prev !== "]" && prev !== "}";
  };

  let scanCode;

  const skipTemplate = () => {
    i += 1;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i += 1;
        return;
      }
      if (c === "$" && text[i + 1] === "{") {
        i += 2;
        scanCode(true);
        continue;
      }
      i += 1;
    }
  };

  scanCode = (inTemplate) => {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const next = text[i + 1];
      if (c === "/" && next === "/") {
        const end = lineEnd(i);
        found.push({ offset: i, text: text.slice(i + 2, end) });
        i = end;
        continue;
      }
      if (c === "/" && next === "*") {
        const close = text.indexOf("*/", i + 2);
        found.push({ offset: i, text: text.slice(i + 2, close < 0 ? n : close) });
        i = close < 0 ? n : close + 2;
        continue;
      }
      if (/\s/.test(c)) {
        i += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        skipQuoted(c);
        prev = "value";
        continue;
      }
      if (c === "`") {
        skipTemplate();
        prev = "value";
        continue;
      }
      if (c === "/") {
        if (regexAllowed()) {
          skipRegex();
          prev = "value";
        } else {
          i += 1;
          prev = "/";
        }
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
        prev = `word:${text.slice(i, j)}`;
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < n && /[0-9A-Za-z_.]/.test(text[j])) j += 1;
        prev = "value";
        i = j;
        continue;
      }
      if (c === "{") depth += 1;
      if (c === "}") {
        if (inTemplate && depth === 0) {
          i += 1;
          return;
        }
        depth -= 1;
      }
      prev = c;
      i += 1;
    }
  };

  if (text.startsWith("#!")) i = lineEnd(0);
  scanCode(false);
  return found.map((comment) => ({
    line: lineNumberAt(text, comment.offset),
    text: comment.text,
    todo: /^[\s*]*TODO\b/.test(comment.text)
  }));
}

export function listSelfFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SELF_SKIP_DIRS.includes(entry.name)) walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (entry.isFile() && SELF_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) out.push(rel);
    }
  };
  walk(root, "");
  return out;
}

function dashFindings(rel, text) {
  const out = [];
  text.split("\n").forEach((line, index) => {
    const found = FORBIDDEN_DASHES.filter((codePoint) => line.includes(String.fromCodePoint(codePoint)));
    if (found.length > 0) {
      out.push(finding("error", rel, `line ${index + 1}: forbidden character ${found.map(codePointLabel).join(", ")}; ${DASH_FIX}`));
    }
  });
  return out;
}

export function lintText(rel, raw) {
  const out = [];
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (text.charCodeAt(0) === 0xfeff) out.push(finding("error", rel, "starts with a byte order mark; save it as UTF-8 without BOM"));
  const innerBom = text.indexOf("\uFEFF", 1);
  if (innerBom >= 0) out.push(finding("error", rel, `line ${lineNumberAt(text, innerBom)}: a raw byte order mark (U+FEFF) inside the text; write it as the escape \\uFEFF`));
  const cr = text.indexOf("\r");
  if (cr >= 0) out.push(finding("error", rel, `line ${lineNumberAt(text, cr)}: carriage return found; use LF line endings only`));
  out.push(...dashFindings(rel, text.replace(/\r/g, "")));
  if (SELF_CODE_EXTENSIONS.includes(path.extname(rel).toLowerCase())) {
    for (const comment of findComments(text)) {
      if (comment.todo) continue;
      out.push(finding("error", rel, `line ${comment.line}: comment found; only TODO comments are allowed, move the reason into a test name, an assertion message or the docs`));
    }
  }
  return out;
}

export function lintSelf(repoRoot) {
  const out = [];
  for (const rel of listSelfFiles(repoRoot)) {
    out.push(...lintText(rel, fs.readFileSync(path.join(repoRoot, ...rel.split("/")))));
  }
  return out;
}

export function countFindings(findings) {
  return {
    errors: findings.filter((item) => item.level === "error").length,
    warnings: findings.filter((item) => item.level === "warning").length
  };
}

export function formatFindings(findings) {
  const lines = findings.map((item) => `[${item.level}] ${item.where}: ${item.message}`);
  const { errors, warnings } = countFindings(findings);
  lines.push(`lint: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  return lines;
}
