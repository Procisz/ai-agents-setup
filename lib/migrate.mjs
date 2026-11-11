import path from "node:path";
import {
  V1_MANIFEST_SCHEMA,
  WfError,
  atomicWrite,
  backupCopyPath,
  foldsCase,
  hashFile,
  isDir,
  isPlainObject,
  listBackups,
  listFiles,
  readBackup,
  readBytes,
  removeEmptyDirs,
  removeFile,
  sha256,
  summarizePaths,
  targetPath,
  toPosix
} from "./core.mjs";

const EXPLORE = "agents/Explore.md";
const MANIFEST_REL = "ai-agents-setup/manifest.json";
const SPAWN_DEPTH = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";
const PRUNABLE = Object.freeze(["/permissions/deny", "/permissions", "/env", "/hooks"]);

export function isV1Manifest(data) {
  return isPlainObject(data) && data.schema === V1_MANIFEST_SCHEMA;
}

export function renderJson(value, indent = "\t", inline = true, depth = 0) {
  const pad = indent.repeat(depth + 1);
  const end = indent.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (inline && value.every((item) => item === null || typeof item !== "object")) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    return `[\n${value.map((item) => pad + renderJson(item, indent, inline, depth + 1)).join(",\n")}\n${end}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((key) => `${pad}${JSON.stringify(key)}: ${renderJson(value[key], indent, inline, depth + 1)}`).join(",\n")}\n${end}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function detectStyle(text, data) {
  const indent = detectIndent(text);
  const normalized = String(text).replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (renderJson(data, indent, true) === normalized) return { indent, inline: true, lossless: true };
  if (renderJson(data, indent, false) === normalized) return { indent, inline: false, lossless: true };
  return { indent, inline: /\[\s*("[^"\n]*"|-?\d[^,\n\]]*|true|false|null)\s*(,[^\n]*)?\]/.test(normalized), lossless: false };
}

export function detectIndent(text) {
  const match = /^\{\r?\n([ \t]+)\S/.exec(String(text ?? ""));
  if (!match) return "\t";
  return match[1].startsWith("\t") ? "\t" : match[1];
}

function hookPrefix(appDir, platform) {
  const prefix = `${toPosix(appDir).replace(/\/+$/, "")}/hooks/`;
  return foldsCase(platform) ? prefix.toLowerCase() : prefix;
}

export function pointsIntoV1Hooks(handler, appDir, platform = process.platform) {
  if (!isPlainObject(handler)) return false;
  const prefix = hookPrefix(appDir, platform);
  const values = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].filter((value) => typeof value === "string");
  return values.some((value) => {
    const text = toPosix(value);
    return (foldsCase(platform) ? text.toLowerCase() : text).includes(prefix);
  });
}

function scriptName(handler) {
  const values = [...(Array.isArray(handler.args) ? handler.args : []), handler.command].filter((value) => typeof value === "string");
  const hit = values.find((value) => /\.mjs/.test(value)) ?? values[0] ?? "";
  const match = /([^\\/"' ]+\.mjs)/.exec(hit);
  return match ? match[1] : path.basename(String(hit));
}

function pointerGet(doc, pointer) {
  let node = doc;
  for (const token of pointer.split("/").slice(1)) {
    if (!isPlainObject(node) || !Object.hasOwn(node, token)) return { present: false };
    node = node[token];
  }
  return { present: true, value: node };
}

function pointerRemove(doc, pointer) {
  const tokens = pointer.split("/").slice(1);
  const last = tokens.pop();
  const parent = tokens.length === 0 ? { present: true, value: doc } : pointerGet(doc, `/${tokens.join("/")}`);
  if (!parent.present || !isPlainObject(parent.value) || !Object.hasOwn(parent.value, last)) return false;
  delete parent.value[last];
  return true;
}

function isEmpty(value) {
  return Array.isArray(value) ? value.length === 0 : isPlainObject(value) && Object.keys(value).length === 0;
}

export function keptSettingsKeys(data) {
  const kept = [];
  for (const [key, value] of Object.entries(data)) {
    if (["hooks", "env", "permissions"].includes(key) && isPlainObject(value)) {
      for (const sub of Object.keys(value)) kept.push(`${key}.${sub}`);
    } else {
      kept.push(key);
    }
  }
  return kept;
}

export function migrateSettings({ text, v1, appDir, platform = process.platform }) {
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new WfError(`settings.json is not valid JSON (${error.message}). Nothing was written. Fix the file, then rerun install.`);
  }
  if (!isPlainObject(data)) throw new WfError("settings.json must hold a JSON object. Nothing was written.");
  const style = detectStyle(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, data);
  const removed = [];
  const settings = isPlainObject(v1?.settings) ? v1.settings : {};

  if (isPlainObject(data.hooks)) {
    for (const event of Object.keys(data.hooks)) {
      const groups = data.hooks[event];
      if (!Array.isArray(groups)) continue;
      let touched = false;
      const keptGroups = [];
      for (const group of groups) {
        if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
          keptGroups.push(group);
          continue;
        }
        const handlers = group.hooks.filter((handler) => {
          if (!pointsIntoV1Hooks(handler, appDir, platform)) return true;
          removed.push(`hooks.${event} ${group.matcher ?? "*"}${handler.if ? ` if ${handler.if}` : ""}: ${scriptName(handler)}`);
          return false;
        });
        if (handlers.length === group.hooks.length) keptGroups.push(group);
        else {
          touched = true;
          if (handlers.length > 0) keptGroups.push({ ...group, hooks: handlers });
        }
      }
      if (!touched) continue;
      if (keptGroups.length > 0) data.hooks[event] = keptGroups;
      else delete data.hooks[event];
    }
  }

  const deny = isPlainObject(data.permissions) && Array.isArray(data.permissions.deny) ? data.permissions.deny : null;
  for (const item of Array.isArray(settings.deny) ? settings.deny : []) {
    if (!deny || item?.preexisting !== false || typeof item.rule !== "string") continue;
    let index = deny.indexOf(item.rule);
    if (index < 0) continue;
    while (index >= 0) {
      deny.splice(index, 1);
      index = deny.indexOf(item.rule);
    }
    removed.push(`permissions.deny ${item.rule}`);
  }

  const prior = isPlainObject(settings.prior) ? settings.prior[`/env/${SPAWN_DEPTH}`] : undefined;
  if (isPlainObject(prior) && prior.present === false && isPlainObject(data.env) && Object.hasOwn(data.env, SPAWN_DEPTH)) {
    delete data.env[SPAWN_DEPTH];
    removed.push(`env.${SPAWN_DEPTH}`);
  }

  const containers = new Set(Array.isArray(settings.containers) ? settings.containers : []);
  for (const pointer of PRUNABLE) {
    if (!containers.has(pointer)) continue;
    const found = pointerGet(data, pointer);
    if (found.present && isEmpty(found.value) && pointerRemove(data, pointer)) removed.push(`${pointer.slice(1).replace(/\//g, ".")} (empty, created by v1)`);
  }

  const out = renderJson(data, style.indent, style.inline) + "\n";
  return { changed: removed.length > 0, text: out, data, removed, kept: keptSettingsKeys(data), indent: style.indent, lossless: style.lossless };
}

function displayPath(paths, base, rel) {
  return base === "launcher" ? targetPath(paths, base, rel) : rel;
}

export function planMigration({ paths, v1, writeTargets = new Set(), platform = process.platform }) {
  const fold = foldsCase(platform);
  const key = (base, rel) => `${base}:${fold ? rel.toLowerCase() : rel}`;
  const targets = new Set([...writeTargets].map((item) => {
    const [base, ...rest] = item.split(":");
    return key(base, rest.join(":"));
  }));
  const sameLauncherDir = !v1.launcherDir || (fold ? String(v1.launcherDir).toLowerCase() === paths.launcherDir.toLowerCase() : v1.launcherDir === paths.launcherDir);
  const notes = [];
  const removeFiles = [];
  const replaced = [];
  for (const entry of Array.isArray(v1.files) ? v1.files : []) {
    if (!isPlainObject(entry) || typeof entry.path !== "string") continue;
    const base = entry.base === "launcher" ? "launcher" : "config";
    if (base === "config" && entry.path === EXPLORE) continue;
    if (base === "launcher" && !sameLauncherDir) {
      notes.push(`v1 launcher ${path.join(v1.launcherDir, entry.path)} is outside the launcher folder; left in place`);
      continue;
    }
    const file = targetPath(paths, base, entry.path, platform);
    const current = hashFile(file);
    const item = { base, path: entry.path, exists: current !== null, modified: current !== null && current !== entry.sha256 };
    if (targets.has(key(base, entry.path))) replaced.push(item);
    else if (item.exists) removeFiles.push(item);
  }

  const overrideEntry = (Array.isArray(v1.files) ? v1.files : []).find((entry) => entry?.path === EXPLORE && (entry.base ?? "config") === "config");
  const adoptedRecord = (Array.isArray(v1.adopted) ? v1.adopted : []).find((entry) => entry?.path === EXPLORE);
  const exploreFile = targetPath(paths, "config", EXPLORE, platform);
  const liveSha = hashFile(exploreFile);
  const explore = { action: "none", reason: "", overrideSha256: overrideEntry?.sha256 ?? null, content: null, sha256: null };
  if (overrideEntry || adoptedRecord) {
    const original = adoptedRecord ? readBytes(path.join(paths.adoptedDir, ...EXPLORE.split("/"))) : null;
    const originalSha = original === null ? null : sha256(original);
    if (original !== null && originalSha === adoptedRecord.sha256) {
      if (liveSha === originalSha) {
        explore.action = "none";
        explore.reason = "your original is already in place";
      } else {
        explore.action = "restore";
        explore.reason = "restore your original from adopted/agents/Explore.md (sha256 matches)";
        explore.content = original;
        explore.sha256 = originalSha;
      }
    } else if (liveSha !== null && overrideEntry) {
      explore.action = "remove";
      explore.reason = adoptedRecord ? "the adopted original is missing or does not match its sha256: the v1 override is removed" : "no adopted original: the v1 override is removed";
    } else {
      explore.reason = "nothing to do";
    }
  }

  const settingsBytes = readBytes(paths.settingsFile);
  const settings = settingsBytes === null ? null : migrateSettings({ text: settingsBytes.toString("utf8"), v1, appDir: paths.appDir, platform });
  if (settings?.changed && !settings.lossless) notes.push("settings.json is rewritten with its own indentation; some formatting may change (the backup keeps the original)");

  const hooksDir = path.join(paths.appDir, "hooks");
  const hookFiles = new Set(removeFiles.filter((item) => item.base === "config" && item.path.startsWith("ai-agents-setup/hooks/")).map((item) => item.path));
  const extraHooks = isDir(hooksDir) ? listFiles(hooksDir).map((rel) => `ai-agents-setup/hooks/${rel}`).filter((rel) => !hookFiles.has(rel)) : [];
  if (extraHooks.length > 0) notes.push(`files in ai-agents-setup/hooks/ that the v1 manifest does not list are left in place: ${extraHooks.join(", ")}`);

  const homeTrust = isPlainObject(v1.homeTrust) ? { file: v1.homeTrust.file ?? null, folder: v1.homeTrust.folder ?? null } : null;
  const cost = isDir(path.join(paths.appDir, "cost"));
  const adopted = (Array.isArray(v1.adopted) ? v1.adopted : []).filter((entry) => entry?.path && entry.path !== EXPLORE).map((entry) => ({ path: entry.path, sha256: entry.sha256 ?? null }));

  const plan = {
    v1,
    removeFiles,
    replaced,
    explore,
    exploreLiveSha: liveSha,
    settings,
    settingsSha256: settingsBytes === null ? null : sha256(settingsBytes),
    notes,
    homeTrust,
    cost,
    adopted,
    backupEntries: [],
    changeCount: 0,
    displayPath: (item) => displayPath(paths, item.base, item.path)
  };
  return countMigration(plan);
}

function countMigration(plan) {
  const entries = [
    ...plan.removeFiles.map((item) => ({ base: item.base, path: item.path, action: "remove" })),
    ...plan.replaced.filter((item) => item.exists).map((item) => ({ base: item.base, path: item.path, action: "update" })),
    { base: "config", path: MANIFEST_REL, action: "update" }
  ];
  if (plan.explore.action !== "none") entries.push({ base: "config", path: EXPLORE, action: plan.explore.action === "restore" ? (plan.exploreLiveSha === null ? "create" : "update") : "remove" });
  if (plan.settings?.changed) entries.push({ base: "config", path: "settings.json", action: "update" });
  plan.backupEntries = entries;
  plan.changeCount = plan.removeFiles.length + (plan.explore.action === "none" ? 0 : 1) + (plan.settings?.changed ? 1 : 0);
  return plan;
}

export function refreshSettings(plan, { paths, platform = process.platform }) {
  const bytes = readBytes(paths.settingsFile);
  const sha = bytes === null ? null : sha256(bytes);
  if (sha === plan.settingsSha256) return false;
  plan.settingsSha256 = sha;
  plan.settings = bytes === null ? null : migrateSettings({ text: bytes.toString("utf8"), v1: plan.v1, appDir: paths.appDir, platform });
  countMigration(plan);
  return true;
}

export function migrationOps(plan, { paths, platform = process.platform }) {
  const ops = plan.removeFiles.map((item) => ({ target: targetPath(paths, item.base, item.path, platform), op: "remove" }));
  const exploreFile = targetPath(paths, "config", EXPLORE, platform);
  if (plan.explore.action === "restore") ops.push({ target: exploreFile, op: "write" });
  else if (plan.explore.action === "remove") ops.push({ target: exploreFile, op: "remove" });
  if (plan.settings?.changed) ops.push({ target: paths.settingsFile, op: "write" });
  return ops;
}

export function v1BackupSets(paths, manifestSha256) {
  if (typeof manifestSha256 !== "string") return [];
  const out = [];
  for (const stamp of listBackups(paths)) {
    let index;
    try {
      index = readBackup(paths, stamp).index;
    } catch {
      continue;
    }
    if (index.partial === true) continue;
    if (index.entries.some((entry) => isPlainObject(entry) && entry.base === "config" && entry.path === MANIFEST_REL && entry.sha256 === manifestSha256)) out.push(stamp);
  }
  return out;
}

export function earlierMigration(paths, stamp, { v1, platform = process.platform }) {
  let set;
  try {
    set = readBackup(paths, stamp);
  } catch {
    return null;
  }
  const removed = set.index.entries.filter((entry) => isPlainObject(entry) && entry.action === "remove" && typeof entry.path === "string" && entry.sha256).map((entry) => displayPath(paths, entry.base, entry.path));
  let settings = null;
  const entry = set.index.entries.find((item) => isPlainObject(item) && item.base === "config" && item.path === "settings.json" && item.sha256);
  const bytes = entry ? readBytes(backupCopyPath(set.dir, "config", "settings.json")) : null;
  if (bytes !== null && sha256(bytes) === entry.sha256) {
    try {
      const result = migrateSettings({ text: bytes.toString("utf8"), v1, appDir: paths.appDir, platform });
      settings = { removed: result.removed, kept: result.kept };
    } catch {}
  }
  return { stamp, removed, settings };
}

export function migrationLines(plan) {
  const lines = ["v1 migration (wf.manifest/1 found); everything below is backed up first:"];
  const removed = plan.removeFiles.map((item) => plan.displayPath(item) + (item.modified ? " (modified)" : ""));
  if (removed.length > 0) lines.push(`  remove ${removed.length} v1 files: ${summarizePaths(removed, 4).join(", ")}`);
  if (plan.replaced.length > 0) lines.push(`  replace with the v2 version: ${plan.replaced.map((item) => plan.displayPath(item)).join(", ")}`);
  if (plan.explore.action !== "none" || plan.explore.reason) lines.push(`  agents/Explore.md: ${plan.explore.reason || "nothing to do"}`);
  if (plan.settings?.changed) {
    const hooks = plan.settings.removed.filter((item) => item.startsWith("hooks.")).length;
    const other = plan.settings.removed.filter((item) => !item.startsWith("hooks."));
    lines.push(`  settings.json: remove ${hooks} wf hook handlers${other.length > 0 ? `, ${other.join(", ")}` : ""}`);
  } else if (plan.settings) {
    lines.push("  settings.json: no v1 entries left");
  }
  const kept = ["rules/house-rules.md stays adopted"];
  if (plan.homeTrust?.file) kept.push(`the home folder trust in ${plan.homeTrust.file}`);
  if (plan.cost) kept.push("ai-agents-setup/cost/");
  lines.push(`  left as they are: ${kept.join(", ")}`);
  for (const note of plan.notes) lines.push(`  note: ${note}`);
  return lines;
}

export function applyMigration(plan, { paths, guard, platform = process.platform, backupStamp, now = new Date() }) {
  refreshSettings(plan, { paths, platform });
  if (plan.settings?.changed) atomicWrite(paths.settingsFile, plan.settings.text, { guard });
  const removed = [];
  const restored = [];
  const exploreFile = targetPath(paths, "config", EXPLORE, platform);
  if (plan.explore.action === "restore") {
    atomicWrite(exploreFile, plan.explore.content, { guard, mode: 0o644 });
    restored.push(EXPLORE);
  }
  for (const item of plan.removeFiles) {
    const file = targetPath(paths, item.base, item.path, platform);
    if (removeFile(file, guard)) removed.push(plan.displayPath(item));
  }
  removeEmptyDirs(path.join(paths.appDir, "hooks"), paths.appDir, guard);
  if (plan.explore.action === "remove" && removeFile(exploreFile, guard)) removed.push(EXPLORE);
  return {
    at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    backup: backupStamp ?? null,
    from: { installedAt: plan.v1.installedAt ?? null, updatedAt: plan.v1.updatedAt ?? null, milestone: plan.v1.milestone ?? null },
    removed,
    replaced: plan.replaced.map((item) => plan.displayPath(item)),
    restored,
    explore: { action: plan.explore.action, overrideSha256: plan.explore.overrideSha256 },
    settings: plan.settings ? { removed: plan.settings.removed, kept: plan.settings.kept } : null,
    left: { homeTrust: plan.homeTrust, cost: plan.cost ? "ai-agents-setup/cost/" : null }
  };
}
