import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  EXIT,
  MANIFEST_SCHEMA,
  V1_MANIFEST_SCHEMA,
  compareVersions,
  createGuard,
  hashFile,
  isDir,
  isFile,
  isPlainObject,
  readJson,
  readManifest,
  readText,
  removeFile,
  targetPath
} from "./core.mjs";
import { DEFAULT_MIN_VERSION, checkClaude, onPath, pathHint, validatePlugin } from "./claude.mjs";
import { pointsIntoV1Hooks, v1BackupSets } from "./migrate.mjs";

const MIN_NODE = "22.0.0";
const HOOK_TIMEOUT_MS = 15000;

function check(name, status, detail) {
  return { name, status, detail };
}

function nodeVersionOf(nodePath) {
  const result = spawnSync(nodePath, ["--version"], { encoding: "utf8", timeout: HOOK_TIMEOUT_MS, windowsHide: true });
  return result.status === 0 ? String(result.stdout).trim().replace(/^v/, "") : null;
}

export function checkNode({ manifest, nodeVersion = process.versions.node }) {
  const checks = [];
  checks.push(compareVersions(nodeVersion, MIN_NODE) >= 0 ? check("node", "ok", `node ${nodeVersion}`) : check("node", "fail", `node ${nodeVersion} is older than 22`));
  const nodePath = manifest?.nodePath;
  if (nodePath) {
    const version = isFile(nodePath) ? nodeVersionOf(nodePath) : null;
    if (version === null) checks.push(check("hook node", "fail", `${nodePath} does not run; set nodePath in ai-agents-setup/local.json and reinstall`));
    else if (compareVersions(version, MIN_NODE) < 0) checks.push(check("hook node", "fail", `${nodePath} is node ${version}, older than 22`));
    else checks.push(check("hook node", "ok", `${nodePath} (node ${version})`));
  }
  return checks;
}

export function checkManifestFiles(paths, manifest, platform = process.platform) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const problems = [];
  for (const entry of files) {
    if (!isPlainObject(entry)) continue;
    const target = targetPath(paths, entry.base, entry.path, platform);
    const hash = hashFile(target);
    if (hash === null) problems.push(`missing ${entry.path}`);
    else if (hash !== entry.sha256) problems.push(`changed ${entry.path}`);
  }
  if (problems.length === 0) return check("manifest files", "ok", `${files.length} files match their sha256`);
  return check("manifest files", "fail", `${problems.length} of ${files.length} differ: ${problems.slice(0, 3).join(", ")}${problems.length > 3 ? ", ..." : ""} (node wf.mjs install repairs them)`);
}

export function checkLauncher(paths, manifest, { env = process.env, platform = process.platform } = {}) {
  const launchers = (Array.isArray(manifest?.files) ? manifest.files : []).filter((entry) => entry?.base === "launcher");
  const names = launchers.length > 0 ? launchers.map((entry) => entry.path) : [platform === "win32" ? "wf.cmd" : "wf"];
  const missing = names.filter((name) => !isFile(path.join(paths.launcherDir, name)));
  const checks = [];
  checks.push(missing.length === 0 ? check("launcher", "ok", names.map((name) => path.join(paths.launcherDir, name)).join(", ")) : check("launcher", "fail", `missing ${missing.map((name) => path.join(paths.launcherDir, name)).join(", ")}`));
  checks.push(onPath(paths.launcherDir, { env, platform }) ? check("PATH", "ok", `${paths.launcherDir} is on PATH`) : check("PATH", "warn", pathHint(paths.launcherDir, { env, platform })));
  return checks;
}

function labelOf(registry, id) {
  const label = registry?.models?.[id]?.label;
  return typeof label === "string" ? label : id;
}

function missingFrom(choices, kind) {
  const chosen = Array.isArray(choices?.[kind]) ? choices[kind] : [];
  const known = Array.isArray(choices?.known?.[kind]) ? choices.known[kind] : chosen;
  return known.filter((id) => !chosen.includes(id));
}

function workerRoles(registry) {
  const roles = isPlainObject(registry?.roles) ? registry.roles : {};
  return Object.entries(roles)
    .filter(([, role]) => isPlainObject(role) && role.main !== true)
    .map(([name]) => name);
}

export function newRoles(manifest, registry) {
  const workers = workerRoles(registry);
  const known = manifest?.choices?.known?.roles;
  if (Array.isArray(known)) return workers.filter((name) => !known.includes(name));
  const agents = Array.isArray(manifest?.agents) ? manifest.agents : [];
  if (agents.length === 0) return [];
  const installed = new Set(agents.map((agent) => agent?.role));
  return workers.filter((name) => !installed.has(name));
}

function newRolesNote(names) {
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} new: node wf.mjs install adds ${names.length === 1 ? "it" : "them"}`;
}

export function checkChoices(manifest, registry = null) {
  const choices = isPlainObject(manifest?.choices) ? manifest.choices : null;
  const fresh = newRoles(manifest, registry);
  const status = fresh.length > 0 ? "warn" : "ok";
  if (!choices) {
    if (fresh.length > 0) return check("choices", status, `no saved choices; ${newRolesNote(fresh)} (the next install starts with everything ticked)`);
    return check("choices", status, "everything installed (no saved choices: the next install starts with everything ticked)");
  }
  const agents = Array.isArray(manifest?.agents) ? manifest.agents : [];
  const tiers = (Array.isArray(choices.tiers) ? choices.tiers : []).map((tier) => String(tier).toUpperCase());
  const parts = [`tiers ${tiers.join(", ") || "none"}`];
  const workers = workerRoles(registry);
  const isWorker = (agent) => (workers.length > 0 ? workers.includes(agent.role) : agent.tier !== null && agent.tier !== undefined);
  const roles = [...new Set(agents.filter(isWorker).map((agent) => agent.role))];
  parts.push(`agents ${roles.join(", ") || "none"}`);
  parts.push(`models ${(Array.isArray(choices.models) ? choices.models : []).map((id) => labelOf(registry, id)).join(", ") || "none"}`);
  const missing = [
    ...missingFrom(choices, "tiers").map((tier) => `${String(tier).toUpperCase()} not installed`),
    ...missingFrom(choices, "roles").filter((name) => !roles.includes(name)).map((name) => `${name} not installed`)
  ];
  const remapped = agents.filter((agent) => typeof agent.remappedFrom === "string");
  if (remapped.length > 0) missing.push(`${remapped.length} agent${remapped.length === 1 ? "" : "s"} on a stand-in model`);
  if (fresh.length > 0) missing.push(newRolesNote(fresh));
  return check("choices", status, `${parts.join("; ")}${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`);
}

export function v1RestoreHint(paths, v1, platform = process.platform) {
  const files = Array.isArray(v1?.files) ? v1.files : [];
  const missing = files.filter((entry) => isPlainObject(entry) && typeof entry.path === "string" && hashFile(targetPath(paths, entry.base === "launcher" ? "launcher" : "config", entry.path, platform)) === null);
  if (missing.length === 0) return null;
  const [stamp] = v1BackupSets(paths, hashFile(paths.manifestFile));
  const how = stamp ? `node wf.mjs restore --to ${stamp} puts the v1 install back, then rerun install` : "node wf.mjs restore lists the backup sets that can put it back";
  return `${missing.length} of the ${files.length} v1 files are missing, so an earlier install may have stopped half way: ${how}`;
}

export function checkLeftovers(paths, manifest, platform = process.platform) {
  const found = [];
  const text = readText(paths.settingsFile);
  if (text !== null) {
    try {
      const data = JSON.parse(text);
      let count = 0;
      for (const groups of isPlainObject(data?.hooks) ? Object.values(data.hooks) : []) {
        for (const group of Array.isArray(groups) ? groups : []) {
          for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) if (pointsIntoV1Hooks(handler, paths.appDir, platform)) count += 1;
        }
      }
      if (count > 0) found.push(`settings.json has ${count} v1 hook handlers`);
    } catch {
      found.push("settings.json is not valid JSON");
    }
  }
  let agents = [];
  try {
    agents = fs.readdirSync(paths.agentsDir).filter((name) => /^wf-.+\.md$/i.test(name));
  } catch {}
  if (agents.length > 0) found.push(`${agents.length} v1 agents in agents/ (${agents.slice(0, 3).join(", ")}${agents.length > 3 ? ", ..." : ""})`);
  const override = manifest?.migratedFromV1?.explore?.overrideSha256;
  if (override && hashFile(path.join(paths.agentsDir, "Explore.md")) === override) found.push("agents/Explore.md is still the v1 override");
  if (isDir(path.join(paths.appDir, "hooks"))) found.push("the v1 folder ai-agents-setup/hooks/ is still there");
  if (found.length === 0) return check("v1 leftovers", "ok", "none");
  return check("v1 leftovers", "fail", `${found.join("; ")} (node wf.mjs install migrates v1)`);
}

export function checkStateWritable(paths, platform = process.platform) {
  try {
    if (isDir(paths.stateDir)) {
      const probe = path.join(paths.stateDir, `.doctor-${crypto.randomBytes(4).toString("hex")}`);
      fs.writeFileSync(probe, "ok\n", { flag: "wx" });
      removeFile(probe, createGuard(paths, platform));
      return check("state folder", "ok", `${paths.stateDir} is writable`);
    }
    fs.accessSync(paths.appDir, fs.constants.W_OK);
    return check("state folder", "ok", `${paths.stateDir} will be created by the hooks (${paths.appDir} is writable)`);
  } catch (error) {
    return check("state folder", "fail", `${paths.stateDir} is not writable: ${error.message}`);
  }
}

function runHook(nodePath, script, args, payload, env) {
  const result = spawnSync(nodePath, [script, ...args], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
    timeout: HOOK_TIMEOUT_MS,
    windowsHide: true
  });
  return { status: typeof result.status === "number" ? result.status : null, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message ?? null };
}

export function hookSelfTest({ paths, nodePath = process.execPath, env = process.env, platform = process.platform }) {
  const hooksDir = path.join(paths.pluginDir, "hooks");
  const guardScript = path.join(hooksDir, "guard.mjs");
  const contextScript = path.join(hooksDir, "context.mjs");
  const compactScript = path.join(hooksDir, "compact.mjs");
  const missing = [guardScript, contextScript, compactScript].filter((file) => !isFile(file));
  if (missing.length > 0) return [check("hook self-test", "fail", `missing ${missing.join(", ")}`)];
  const config = (() => {
    try {
      return readJson(path.join(hooksDir, "config.json"));
    } catch {
      return null;
    }
  })();
  const stateDir = typeof config?.stateDir === "string" ? config.stateDir : paths.stateDir;
  const hookEnv = { ...env };
  delete hookEnv.WF_CONTEXT_WINDOW;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-doctor-"));
  const sessionId = `wf-doctor-${crypto.randomBytes(6).toString("hex")}`;
  const transcript = path.join(tmp, "main.jsonl");
  const usage = { input_tokens: 1200, cache_creation_input_tokens: 3400, cache_read_input_tokens: 5600, output_tokens: 20 };
  const expected = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const stamp = new Date().toISOString();
  fs.writeFileSync(
    transcript,
    [
      { type: "user", timestamp: stamp, sessionId, message: { role: "user", content: "wf doctor self-test" } },
      { type: "assistant", timestamp: stamp, sessionId, message: { role: "assistant", model: "claude-opus-5-5", usage, content: [{ type: "text", text: "ok" }] } }
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n"
  );
  const base = { session_id: sessionId, transcript_path: transcript, cwd: tmp };
  const checks = [];
  try {
    const refused = runHook(nodePath, guardScript, [], { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wf-doctor" }, agent_id: "wf-doctor-agent", agent_type: "wf:coder-t1" }, hookEnv);
    const allowed = runHook(nodePath, guardScript, [], { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } }, hookEnv);
    const gitAgent = runHook(nodePath, guardScript, [], { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wf-doctor" }, agent_id: "wf-doctor-git", agent_type: "wf:git" }, hookEnv);
    if (refused.status === 2 && /wf guard/.test(refused.stderr) && allowed.status === 0 && gitAgent.status === 0) checks.push(check("guard hook", "ok", "refuses a subagent git commit, allows git status and a wf:git commit"));
    else checks.push(check("guard hook", "fail", `subagent git commit exit ${refused.status} (want 2), git status exit ${allowed.status} (want 0), wf:git git commit exit ${gitAgent.status} (want 0)${refused.error ? `: ${refused.error}` : ""}`));
    const context = runHook(nodePath, contextScript, [], { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: transcript }, tool_response: {} }, hookEnv);
    const ledgerFile = path.join(stateDir, `${sessionId}.json`);
    let ledger = null;
    try {
      ledger = readJson(ledgerFile);
    } catch {}
    const tokens = ledger?.agents?.main?.tokens;
    if (context.status === 0 && tokens === expected) checks.push(check("context hook", "ok", `read ${expected} tokens from a fixture transcript`));
    else checks.push(check("context hook", "fail", `exit ${context.status}, ledger tokens ${tokens ?? "none"} (want ${expected})${context.error ? `: ${context.error}` : ""}`));
    if (ledger !== null) {
      try {
        removeFile(ledgerFile, createGuard(paths, platform));
      } catch {}
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return checks;
}

export async function doctor({ paths, env = process.env, platform = process.platform, minVersion = DEFAULT_MIN_VERSION, skipClaude = false, io, nodeVersion = process.versions.node, registry = null }) {
  const checks = [];
  let manifest = null;
  try {
    const read = readManifest(paths);
    if (!read.exists) checks.push(check("manifest", "fail", `no manifest in ${paths.appDir}: run node wf.mjs install`));
    else if (read.schema === V1_MANIFEST_SCHEMA) {
      const hint = v1RestoreHint(paths, read.data, platform);
      checks.push(check("manifest", "fail", hint ? `a v1 install (wf.manifest/1); ${hint}` : "a v1 install (wf.manifest/1): run node wf.mjs install to migrate"));
    }
    else if (read.schema !== MANIFEST_SCHEMA) checks.push(check("manifest", "fail", `unknown schema ${read.schema}`));
    else {
      manifest = read.data;
      checks.push(check("manifest", "ok", `${MANIFEST_SCHEMA}, installed ${manifest.installedAt ?? "?"}, updated ${manifest.updatedAt ?? "?"}`));
    }
  } catch (error) {
    checks.push(check("manifest", "fail", error.message));
  }
  checks.push(...checkNode({ manifest, nodeVersion }));
  let claude = null;
  if (skipClaude) checks.push(check("claude", "skip", "--skip-claude"));
  else {
    claude = checkClaude({ env, platform, minVersion });
    checks.push(check("claude", claude.ok ? "ok" : "fail", claude.message));
  }
  if (manifest) {
    checks.push(...checkLauncher(paths, manifest, { env, platform }));
    checks.push(checkManifestFiles(paths, manifest, platform));
    checks.push(checkChoices(manifest, registry));
    if (claude?.bin) {
      const validation = validatePlugin(claude.bin, paths.pluginDir, { env });
      checks.push(check("plugin validate", validation.ran ? (validation.ok ? "ok" : "fail") : "skip", validation.detail));
    }
  }
  checks.push(checkLeftovers(paths, manifest, platform));
  checks.push(checkStateWritable(paths, platform));
  if (manifest) {
    const hookNode = checks.find((item) => item.name === "hook node");
    if (hookNode?.status === "fail") checks.push(check("hook self-test", "skip", "the hook node does not run, so the hooks cannot be tested (see hook node)"));
    else checks.push(...hookSelfTest({ paths, nodePath: manifest.nodePath || process.execPath, env, platform }));
  }
  const width = Math.max(...checks.map((item) => item.name.length));
  for (const item of checks) io.print(`${item.status.padEnd(4)}  ${item.name.padEnd(width)}  ${item.detail}`);
  const failed = checks.filter((item) => item.status === "fail").length;
  const warned = checks.filter((item) => item.status === "warn").length;
  io.print(failed === 0 ? `wf doctor: all good${warned > 0 ? ` (${warned} warning${warned > 1 ? "s" : ""})` : ""}.` : `wf doctor: ${failed} problem${failed > 1 ? "s" : ""} found.`);
  return { code: failed === 0 ? EXIT.OK : EXIT.PROBLEMS, checks };
}
