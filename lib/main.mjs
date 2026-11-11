import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { EXIT, MANIFEST_SCHEMA, WfError, compareVersions, isFile, isPlainObject, readJson, readManifest, resolveNodePath, resolvePaths } from "./core.mjs";
import { DEFAULT_MIN_VERSION, checkClaude, validatePlugin } from "./claude.mjs";
import { WF_VERSION, diff, install, prepareInstall, reportLines, restore, uninstall } from "./apply.mjs";
import { doctor } from "./doctor.mjs";
import { normalizeRoles } from "./compile.mjs";
import { MARGIN, PLAIN_UI, detectUi } from "./ui.mjs";
import { multiSelect, singleSelect } from "./prompt.mjs";
import { askChoices, askNext, choiceLines, installModel, resolveSetup, resolveStart, savedChoices, setupSummaryLines, summaryLines } from "./select.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INSTALL_ABOUT = "Sets up wf for Claude Code: agents, skills, hooks and the launcher.";

const LOCATION = ["config-dir", "launcher-dir"];

export const COMMANDS = Object.freeze({
  install: { options: [...LOCATION, "yes", "dry-run", "reset", "skills-reset", "json", "skip-claude"], summary: "check Claude Code, lint, choose tiers, agents, models and skills, compile, show the plan, back up, write, verify" },
  uninstall: { options: [...LOCATION, "yes"], summary: "back up and remove everything wf installed (keeps backups/ and adopted/; --yes without a terminal)" },
  restore: { options: [...LOCATION, "yes", "to"], summary: "put a backup set back (latest by default, or --to <stamp>; --yes without a terminal)" },
  diff: { options: [...LOCATION, "reset", "skip-claude"], summary: "show what install would change with the saved choices, with line counts" },
  doctor: { options: [...LOCATION, "skip-claude"], summary: "health checks: versions, launcher, hashes, choices, plugin, v1 leftovers, hook self-test" },
  lint: { options: [...LOCATION, "self"], summary: "lint the sources (--self also checks the repo house rules)" }
});

const OPTIONS = Object.freeze({
  "config-dir": { type: "string" },
  "launcher-dir": { type: "string" },
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  reset: { type: "boolean" },
  "skills-reset": { type: "boolean" },
  json: { type: "boolean" },
  "skip-claude": { type: "boolean" },
  self: { type: "boolean" },
  to: { type: "string" },
  help: { type: "boolean", short: "h" }
});

export function helpText() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    "usage: node wf.mjs <command> [options]",
    "",
    "commands:",
    ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`),
    "",
    "options:",
    "  --yes, -y             no questions: tiers, agents, models and skills from the saved answers,",
    "                        else the defaults; without a terminal, uninstall and restore only",
    "                        preview unless given --yes",
    "  --dry-run             install: show the plan only",
    "  --reset               install, diff: start from the defaults instead of the saved answers",
    "  --skills-reset        install: the same as --reset",
    "  --json                install: no questions; print one JSON object with the result",
    "  --to <stamp>          restore: the backup set to put back",
    "  --self                lint: also check the repo house rules",
    "  --config-dir <abs>    config home (default: CLAUDE_CONFIG_DIR or ~/.claude), for tests",
    "  --launcher-dir <abs>  launcher folder (default: ~/.local/bin), for tests",
    "  --skip-claude         do not run claude (tests)",
    "",
    "exit codes: 0 ok, 1 problems found, 2 usage error"
  ].join("\n");
}

export function parseCommandLine(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new WfError(error.message, EXIT.USAGE);
  }
  const [command, ...rest] = parsed.positionals;
  const flags = {};
  for (const [name, value] of Object.entries(parsed.values)) flags[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  if (flags.help || command === "help") return { command: "help", flags, given: [] };
  if (!command) return { command: null, flags, given: [] };
  if (!Object.hasOwn(COMMANDS, command)) throw new WfError(`unknown command: ${command}`, EXIT.USAGE);
  if (rest.length > 0) throw new WfError(`${command} takes no arguments: ${rest.join(" ")}`, EXIT.USAGE);
  const given = Object.keys(parsed.values);
  const bad = given.filter((name) => !COMMANDS[command].options.includes(name));
  if (bad.length > 0) throw new WfError(`${command} does not take ${bad.map((name) => `--${name}`).join(", ")}`, EXIT.USAGE);
  if (command === "restore" && flags.to !== undefined && !/^\d{8}T\d{6}Z(-\d+)?$/.test(flags.to)) throw new WfError(`--to needs a backup stamp like 20261028T120000Z: ${flags.to}`, EXIT.USAGE);
  return { command, flags, given };
}

function itemNote(item) {
  return String(item.hint ?? "").replace(/\s+/g, " ").trim() || (item.locked ? "required" : "");
}

export function fitLine(text, columns) {
  if (!Number.isInteger(columns) || columns < 20 || text.length <= columns - 1) return text;
  return `${text.slice(0, columns - 4)}...`;
}

export async function lineMultiSelect({ title, items, min = 0 }, ask, print, { columns } = {}) {
  const checked = items.map((item) => Boolean(item.checked || item.locked));
  for (;;) {
    print(`? ${title}`);
    items.forEach((item, index) => {
      const mark = checked[index] ? "[x]" : "[ ]";
      const note = itemNote(item);
      print(fitLine(`  ${String(index + 1).padStart(2)} ${mark} ${item.label}${note ? `  (${note})` : ""}`, columns));
    });
    const answer = String(await ask("  numbers to toggle, enter to accept: ")).trim();
    if (answer === "") {
      const values = items.filter((_, index) => checked[index]).map((item) => item.value);
      if (values.length >= min) return values;
      print(`  pick at least ${min}`);
      continue;
    }
    for (const token of answer.split(/[\s,]+/)) {
      const index = Number(token) - 1;
      if (Number.isInteger(index) && index >= 0 && index < items.length && !items[index].locked) checked[index] = !checked[index];
    }
  }
}

export async function lineSelect({ title, items }, ask, print, { columns } = {}) {
  for (;;) {
    print(`? ${title}`);
    items.forEach((item, index) => {
      const note = itemNote(item);
      print(fitLine(`  ${String(index + 1).padStart(2)} ${item.label}${note ? `  (${note})` : ""}`, columns));
    });
    const answer = String(await ask("  number, enter for 1: ")).trim();
    if (answer === "") return items[0]?.value ?? null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < items.length) return items[index].value;
  }
}

export function dumbTerminal(env = {}) {
  return env.TERM === "dumb";
}

export function terminalIo({ input = process.stdin, output = process.stdout, env = process.env, platform = process.platform } = {}) {
  const ui = detectUi({ stream: output, env, platform });
  const dumb = dumbTerminal(env);
  const print = (line) => output.write(`${line}\n`);
  const ask = (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input, output, terminal: dumb ? false : undefined });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  const keys = Boolean(input.isTTY) && typeof input.setRawMode === "function" && !dumb;
  const indent = ui.rich ? MARGIN : "";
  const linePrint = (line) => print(`${indent}${line}`);
  const lineAsk = (question) => ask(`${indent}${question}`);
  const lineColumns = () => (output.isTTY ? (output.columns || 80) - indent.length : undefined);
  return {
    ui,
    interactive: Boolean(input.isTTY && output.isTTY),
    print,
    confirm: async (question) => /^y(es)?$/i.test(String(await ask(`${question} [y/N] `)).trim()),
    multiSelect: (options) => (keys ? multiSelect({ input, output, ui, ...options }) : lineMultiSelect(options, lineAsk, linePrint, { columns: lineColumns() })),
    select: (options) => (keys ? singleSelect({ input, output, ui, ...options }) : lineSelect(options, lineAsk, linePrint, { columns: lineColumns() }))
  };
}

export function jsonIo(messages) {
  return {
    ui: PLAIN_UI,
    interactive: false,
    print: (line) => messages.push(String(line)),
    confirm: async () => true,
    multiSelect: async () => null,
    select: async () => null
  };
}

async function loadModules(overrides = {}) {
  const pick = async (name, file, exportName) => {
    if (overrides[name]) return overrides[name];
    const mod = await import(file);
    if (typeof mod[exportName] !== "function") throw new WfError(`${file} does not export ${exportName}`);
    return mod[exportName];
  };
  return {
    loadSources: await pick("loadSources", "./compile.mjs", "loadSources"),
    compile: await pick("compile", "./compile.mjs", "compile"),
    lintSources: await pick("lintSources", "./lint.mjs", "lintSources"),
    lintSelf: await pick("lintSelf", "./lint.mjs", "lintSelf")
  };
}

function v2Manifest(manifest) {
  return Boolean(manifest?.exists && manifest.schema === MANIFEST_SCHEMA && isPlainObject(manifest.data));
}

export function savedSelection(manifest) {
  if (!v2Manifest(manifest) || !isPlainObject(manifest.data.skills)) return null;
  const skills = manifest.data.skills;
  return isPlainObject(skills.selection) ? { selection: skills.selection, skills: Array.isArray(skills.known) ? skills.known : [] } : null;
}

export function savedSetup(manifest) {
  if (!v2Manifest(manifest)) return null;
  return { choices: isPlainObject(manifest.data.choices) ? manifest.data.choices : null, skills: savedSelection(manifest) };
}

function say(io, lines) {
  for (const line of Array.isArray(lines) ? lines : [lines]) io.print(line);
}

function printFindings(io, findings, { limit = 12, ui = PLAIN_UI } = {}) {
  const errors = findings.filter((item) => item.level === "error");
  const warnings = findings.filter((item) => item.level !== "error");
  for (const item of [...errors, ...warnings].slice(0, limit)) {
    const plain = `  ${item.level} ${item.where}: ${item.message}`;
    say(io, ui.status(item.level === "error" ? "fail" : "warn", `${item.where}: ${item.message}`, { plain }));
  }
  if (findings.length > limit) say(io, ui.text(`... ${findings.length - limit} more`, { style: "dim" }).map((line) => (ui.rich ? line : `  ${line}`)));
  return { errors: errors.length, warnings: warnings.length };
}

const VERSION_MANAGED_NODE = /[\\/](?:\.nvm[\\/]versions|\.fnm|fnm[\\/]node-versions|\.asdf[\\/]installs|\.volta[\\/]tools|mise[\\/]installs|\.nodenv[\\/]versions|\.n[\\/]n[\\/]versions)[\\/]/;
const MIN_NODE = "22.0.0";

export function versionManagedNode(nodePath) {
  return VERSION_MANAGED_NODE.test(String(nodePath ?? ""));
}

export function checkLocalNode(nodePath, { run = spawnSync } = {}) {
  if (!isFile(nodePath)) return `${nodePath} does not exist`;
  const result = run(nodePath, ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
  const version = result.status === 0 ? String(result.stdout ?? "").trim().replace(/^v/, "") : null;
  if (version === null || compareVersions(version, MIN_NODE) === null) return `${nodePath} does not run as node`;
  if (compareVersions(version, MIN_NODE) < 0) return `${nodePath} is node ${version}, older than 22`;
  return null;
}

export function nodePathNotes({ nodePath, appDir, run } = {}) {
  const local = path.join(appDir, "local.json");
  if (fs.existsSync(local)) {
    const problem = checkLocalNode(nodePath, { run });
    if (problem) throw new WfError(`${local}: nodePath ${problem}; the hooks need node 22 or newer. Fix nodePath, then rerun. Nothing was written.`);
    return [];
  }
  if (!versionManagedNode(nodePath)) return [];
  return [
    `warning: the hooks will run ${nodePath}, a node of a version manager. If that version is removed, the hooks cannot start: every git and gh command in wf sessions is then refused and the context notices stop. Use a node that stays (for example brew install node, then reinstall), or put {"nodePath": "<absolute path to node>"} in ${local}.`
  ];
}

function minVersionOf(registry) {
  return typeof registry?.claude?.minVersion === "string" ? registry.claude.minVersion : DEFAULT_MIN_VERSION;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function prepareSources(ctx, flags) {
  const { io, ui, env, platform, paths, repoRoot } = ctx;
  const modules = await loadModules(ctx.modules);
  const sources = modules.loadSources(repoRoot);
  const findings = modules.lintSources(sources);
  const counts = printFindings(io, findings, { ui });
  const lint = `Lint: ${counts.errors} errors, ${counts.warnings} warnings`;
  say(io, ui.status(counts.errors > 0 ? "fail" : counts.warnings > 0 ? "warn" : "ok", lint));
  if (counts.errors > 0) throw new WfError("the sources have lint errors; nothing was written");
  const nodePath = resolveNodePath({ appDir: paths.appDir, env, platform });
  for (const line of nodePathNotes({ nodePath, appDir: paths.appDir, run: ctx.runNode })) say(io, ui.status("warn", capitalize(line.replace(/^warning: /, "")), { plain: line }));
  const registry = isPlainObject(sources.registry) ? sources.registry : {};
  const roles = Array.isArray(sources.roles) ? sources.roles : normalizeRoles(registry);
  const model = installModel({ registry, roles });
  const saved = savedSetup(readManifest(paths));
  const start = resolveStart({ model, skills: sources.skills, saved, reset: Boolean(flags.reset || flags.skillsReset) });
  return { modules, sources, model, nodePath, start };
}

function compileFor(ctx, prepared, choices) {
  const { modules, sources, nodePath } = prepared;
  return modules.compile(sources, {
    paths: ctx.paths,
    nodePath,
    platform: ctx.platform,
    selection: choices.skills,
    choices: { tiers: choices.tiers, roles: choices.roles, models: choices.models }
  });
}

function preflightLines(ctx) {
  const { ui, paths } = ctx;
  if (!ui.rich) return [`wf install: ${paths.configHome} (launcher ${paths.launcherDir})`];
  return [...ui.header({ name: "wf", version: WF_VERSION, about: INSTALL_ABOUT }), ...ui.row("Config", paths.configHome, { pad: 8 }), ...ui.row("Launcher", paths.launcherDir, { pad: 8 }), ""];
}

async function chooseInteractively(ctx, prepared) {
  const { io, ui, paths, platform } = ctx;
  const { model, sources } = prepared;
  let start = prepared.start;
  for (;;) {
    const choices = await askChoices({ model, skills: sources.skills, start, io, ui });
    if (!choices) return null;
    const build = compileFor(ctx, prepared, choices);
    const setup = resolveSetup(model, choices);
    say(io, summaryLines({ setup, model, choices, ui }));
    say(io, ui.blank());
    say(io, reportLines(paths, prepareInstall({ paths, build, platform }), ui));
    say(io, ui.blank());
    const next = await askNext({ io, ui });
    if (next === "install") return { choices, build, setup };
    if (next === "cancel") return null;
    start = choices;
  }
}

async function cmdInstall(ctx, flags) {
  const { io, ui, env, platform, paths, repoRoot } = ctx;
  say(io, preflightLines(ctx));
  let claude = null;
  if (flags.skipClaude) say(io, ui.status("info", "Claude Code: check skipped (--skip-claude)"));
  else {
    const registry = readJson(path.join(repoRoot, "registry.json"));
    claude = checkClaude({ env, platform, minVersion: minVersionOf(registry) });
    say(io, claude.ok ? ui.status("ok", claude.message) : ui.status("fail", `Claude Code: ${claude.message}`));
    if (!claude.ok) return EXIT.PROBLEMS;
  }
  const interactive = ctx.interactive && !flags.yes && !flags.dryRun && !flags.json;
  const prepared = await prepareSources(ctx, flags);
  const { model, sources, nodePath } = prepared;
  let picked;
  if (interactive) {
    picked = await chooseInteractively(ctx, prepared);
    if (!picked) {
      say(io, ui.blank());
      say(io, ui.status("info", "Cancelled: nothing was written."));
      return EXIT.PROBLEMS;
    }
  } else {
    const choices = prepared.start;
    const setup = resolveSetup(model, choices);
    say(io, choiceLines({ setup, model, choices, ui }));
    say(io, ui.blank());
    picked = { choices, setup, build: compileFor(ctx, prepared, choices) };
  }
  const { choices, setup, build } = picked;
  if (interactive) say(io, ui.blank());
  const result = await install({
    paths,
    build,
    selection: choices.skills,
    choices: savedChoices(choices, model),
    skills: (sources.skills ?? []).map((skill) => skill.name),
    repoRoot,
    nodePath,
    claudeVersion: claude?.version ?? null,
    platform,
    env,
    dryRun: Boolean(flags.dryRun),
    yes: Boolean(flags.yes) || interactive,
    interactive: ctx.interactive && !flags.json,
    io,
    ui,
    announced: interactive,
    now: ctx.now(),
    validate: claude?.bin ? (dir) => validatePlugin(claude.bin, dir, { env }) : null
  });
  ctx.report = {
    choices: { tiers: choices.tiers, roles: choices.roles, models: choices.models, skills: choices.skills },
    notes: setupSummaryLines(setup, model),
    changes: result.changes,
    written: Boolean(result.written),
    backup: result.backup?.stamp ?? null,
    dryRun: Boolean(flags.dryRun)
  };
  return result.code;
}

async function cmdDiff(ctx, flags) {
  const prepared = await prepareSources(ctx, flags);
  const choices = prepared.start;
  const setup = resolveSetup(prepared.model, choices);
  say(ctx.io, choiceLines({ setup, model: prepared.model, choices, ui: ctx.ui }));
  return diff({ paths: ctx.paths, build: compileFor(ctx, prepared, choices), platform: ctx.platform, io: ctx.io, ui: ctx.ui }).code;
}

async function cmdLint(ctx, flags) {
  const modules = await loadModules(ctx.modules);
  const findings = [...modules.lintSources(modules.loadSources(ctx.repoRoot))];
  if (flags.self) findings.push(...modules.lintSelf(ctx.repoRoot));
  const counts = printFindings(ctx.io, findings, { limit: 200 });
  ctx.io.print(`wf lint${flags.self ? " --self" : ""}: ${counts.errors} errors, ${counts.warnings} warnings`);
  return counts.errors > 0 ? EXIT.PROBLEMS : EXIT.OK;
}

async function cmdDoctor(ctx, flags) {
  let registry = null;
  try {
    registry = readJson(path.join(ctx.repoRoot, "registry.json"));
  } catch {}
  const result = await doctor({ paths: ctx.paths, env: ctx.env, platform: ctx.platform, minVersion: minVersionOf(registry), skipClaude: Boolean(flags.skipClaude), io: ctx.io, registry });
  return result.code;
}

function jsonReport(command, code, ctx, messages, error = null) {
  return JSON.stringify({ command, ok: code === EXIT.OK, code, ...(ctx?.report ?? {}), ...(error ? { error } : {}), messages }, null, 2);
}

export async function main(argv, deps = {}) {
  const outer = deps.io ?? terminalIo();
  let io = outer;
  let command = null;
  let messages = null;
  let ctx = null;
  try {
    const parsed = parseCommandLine(argv);
    command = parsed.command;
    const flags = parsed.flags;
    if (command === "help") {
      io.print(helpText());
      return EXIT.OK;
    }
    if (command === null) {
      io.print(helpText());
      return EXIT.USAGE;
    }
    if (flags.json) {
      messages = [];
      io = jsonIo(messages);
    }
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const paths = resolvePaths({ configDir: flags.configDir, launcherDir: flags.launcherDir, env, platform, homedir: deps.homedir });
    ctx = {
      io,
      ui: messages ? PLAIN_UI : deps.ui ?? io.ui ?? PLAIN_UI,
      env,
      platform,
      paths,
      repoRoot: deps.repoRoot ?? REPO_ROOT,
      interactive: messages ? false : deps.interactive ?? Boolean(io.interactive),
      modules: deps.modules ?? {},
      runNode: deps.runNode,
      now: deps.now ?? (() => new Date()),
      report: null
    };
    let code = EXIT.USAGE;
    if (command === "install") code = await cmdInstall(ctx, flags);
    else if (command === "diff") code = await cmdDiff(ctx, flags);
    else if (command === "lint") code = await cmdLint(ctx, flags);
    else if (command === "doctor") code = await cmdDoctor(ctx, flags);
    else if (command === "uninstall") code = (await uninstall({ paths, platform, yes: Boolean(flags.yes), interactive: ctx.interactive, io, now: ctx.now() })).code;
    else if (command === "restore") code = (await restore({ paths, to: flags.to ?? null, platform, yes: Boolean(flags.yes), interactive: ctx.interactive, io, now: ctx.now() })).code;
    if (messages) outer.print(jsonReport(command, code, ctx, messages));
    return code;
  } catch (error) {
    const known = error instanceof WfError;
    const code = known ? error.exitCode : EXIT.PROBLEMS;
    const text = known ? error.message : `unexpected error: ${error?.stack ?? error}`;
    if (messages) {
      outer.print(jsonReport(command, code, ctx, messages, text));
      return code;
    }
    io.print(`wf: ${text}`);
    if (known && error.exitCode === EXIT.USAGE) io.print("Run node wf.mjs --help for usage.");
    return code;
  }
}
