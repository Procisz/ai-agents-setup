import path from "node:path";
import {
  EXIT,
  MANIFEST_SCHEMA,
  V1_MANIFEST_SCHEMA,
  WfError,
  atomicWrite,
  backupCopyPath,
  createBackup,
  createGuard,
  fileMode,
  formatJson,
  hashFile,
  isPlainObject,
  isoTime,
  listBackups,
  listFiles,
  modeText,
  parseMode,
  preflightTarget,
  pruneBackups,
  readBackup,
  readBytes,
  readJson,
  readManifest,
  readText,
  removeEmptyDirs,
  removeFile,
  removeTree,
  sha256,
  summarizePaths,
  targetPath,
  writeManifest
} from "./core.mjs";
import { applyMigration, earlierMigration, migrationLines, migrationOps, planMigration, refreshSettings, v1BackupSets } from "./migrate.mjs";
import { onPath, pathHint } from "./claude.mjs";
import { MARGIN, PLAIN_UI } from "./ui.mjs";

export const WF_VERSION = "2.1.2";
const MANIFEST_REL = "ai-agents-setup/manifest.json";
const ADOPTED_RECORD_REL = "ai-agents-setup/adopted/record.json";
const ADOPTED_SCHEMA = "wf.adopted/1";
const HOUSE_RULES = "rules/house-rules.md";
export const NEXT_HINT = "Next: run wf in a project folder.";
const PLAN_STYLES = Object.freeze({ create: "green", update: "yellow", remove: "red" });

function keyOf(base, rel) {
  return `${base}:${rel}`;
}

function contentBytes(file) {
  return Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content), "utf8");
}

export function planFiles({ paths, build, previous = [], platform = process.platform }) {
  const actions = [];
  const wanted = new Set();
  for (const file of build.files) {
    const target = targetPath(paths, file.base, file.path, platform);
    const bytes = contentBytes(file);
    const hash = sha256(bytes);
    const mode = file.mode ?? 0o644;
    wanted.add(keyOf(file.base, file.path));
    const currentHash = hashFile(target);
    const before = previous.find((entry) => entry.base === file.base && entry.path === file.path);
    let action = "unchanged";
    if (currentHash === null) action = "create";
    else if (currentHash !== hash) action = "update";
    else if (platform !== "win32" && fileMode(target) !== mode) action = "update";
    const drift = Boolean(before && currentHash !== null && before.sha256 && currentHash !== before.sha256);
    actions.push({ base: file.base, path: file.path, target, action, sha256: hash, mode, bytes, drift });
  }
  for (const entry of previous) {
    if (!isPlainObject(entry) || wanted.has(keyOf(entry.base, entry.path))) continue;
    const target = targetPath(paths, entry.base, entry.path, platform);
    if (hashFile(target) === null) continue;
    actions.push({ base: entry.base, path: entry.path, target, action: "remove", sha256: null, mode: null, bytes: null, drift: false });
  }
  return actions;
}

function display(paths, item) {
  return item.base === "launcher" ? targetPath(paths, item.base, item.path) : item.path;
}

export function planLines(paths, actions, ui = PLAIN_UI) {
  const counts = { create: 0, update: 0, remove: 0, unchanged: 0 };
  for (const item of actions) counts[item.action] += 1;
  const sep = ui.unicode ? ` ${ui.sym("sep")} ` : ", ";
  const total = `${counts.create} create${sep}${counts.update} update${sep}${counts.remove} remove${sep}${counts.unchanged} unchanged`;
  const lines = ui.rich ? [`${MARGIN}${ui.paint("bold", "Plan")}  ${total}`] : [`Plan: ${total}`];
  for (const action of ["create", "update", "remove"]) {
    const list = actions.filter((item) => item.action === action).map((item) => display(paths, item) + (item.drift ? " (changed since the last install)" : ""));
    for (const line of summarizePaths(list, 10)) {
      if (ui.rich) lines.push(ui.fit([{ text: `${MARGIN}  ` }, { text: `${ui.sym(action)} ${action.padEnd(6)}`, style: PLAN_STYLES[action] }, { text: `  ${line}` }]));
      else lines.push(`  ${action.padEnd(6)}  ${line}`);
    }
  }
  return lines;
}

export function migrationBlock(migration, ui = PLAIN_UI) {
  const lines = migrationLines(migration);
  if (!ui.rich) return lines;
  return [...ui.status("warn", lines[0]), ...lines.slice(1).flatMap((line) => ui.para(line.trim(), { first: `${MARGIN}  `, rest: `${MARGIN}    ` }))];
}

export function reportLines(paths, prepared, ui = PLAIN_UI) {
  const lines = [];
  if (prepared.migration) lines.push(...migrationBlock(prepared.migration, ui), ...ui.blank());
  for (const note of prepared.notes) lines.push(...ui.status("info", note, { plain: `note: ${note}` }));
  lines.push(...planLines(paths, prepared.actions, ui));
  return lines;
}

function say(io, lines) {
  for (const line of lines) io.print(line);
}

function lineDiffCounts(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const count = (list) => list.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  let added = 0;
  let removed = 0;
  for (const [line, n] of cb) added += Math.max(0, n - (ca.get(line) ?? 0));
  for (const [line, n] of ca) removed += Math.max(0, n - (cb.get(line) ?? 0));
  return { added, removed };
}

function previousV2(manifest) {
  if (!manifest.exists) return null;
  if (manifest.schema === MANIFEST_SCHEMA) return manifest.data;
  if (manifest.schema === V1_MANIFEST_SCHEMA) return null;
  throw new WfError(`unknown manifest schema ${manifest.schema} in the manifest; nothing was written`);
}

export function buildManifest({ previous, paths, build, selection, choices = null, skills, repoRoot, nodePath, claudeVersion, platform, migration, fallback = null, readopted = null, now }) {
  const time = isoTime(now);
  const data = {
    schema: MANIFEST_SCHEMA,
    version: WF_VERSION,
    installedAt: previous?.installedAt ?? time,
    updatedAt: time,
    repo: repoRoot ?? null,
    configHome: paths.configHome,
    launcherDir: paths.launcherDir,
    platform,
    nodePath: nodePath ?? null,
    claudeVersion: claudeVersion ?? null,
    ...(choices ? { choices } : {}),
    skills: { known: [...(skills ?? [])].sort(), selection: selection ?? {} },
    agents: build.agents ?? [],
    files: build.files.map((file) => ({ base: file.base, path: file.path, sha256: sha256(contentBytes(file)), mode: modeText(file.mode ?? 0o644) }))
  };
  const adopted = migration?.adopted ?? previous?.adopted ?? readopted ?? fallback?.adopted;
  if (adopted && adopted.length > 0) data.adopted = adopted;
  const migrated = migration?.record ?? previous?.migratedFromV1 ?? fallback?.migratedFromV1;
  if (migrated) data.migratedFromV1 = migrated;
  return data;
}

export function readAdoptedRecord(paths) {
  let data;
  try {
    data = readJson(path.join(paths.adoptedDir, "record.json"));
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  return {
    adopted: Array.isArray(data.adopted) ? data.adopted.filter((entry) => isPlainObject(entry) && typeof entry.path === "string") : [],
    migratedFromV1: isPlainObject(data.migratedFromV1) ? data.migratedFromV1 : null
  };
}

function writeAdoptedRecord(paths, guard, adopted, record) {
  atomicWrite(path.join(paths.adoptedDir, "record.json"), formatJson({ schema: ADOPTED_SCHEMA, adopted, migratedFromV1: record }), { guard, mode: 0o644 });
}

export function keepSets(paths) {
  const out = new Set();
  const add = (stamp) => {
    if (typeof stamp === "string" && stamp !== "") out.add(stamp);
  };
  let manifest = null;
  try {
    manifest = readManifest(paths);
  } catch {}
  if (manifest?.schema === MANIFEST_SCHEMA) add(manifest.data.migratedFromV1?.backup);
  else if (manifest?.schema === V1_MANIFEST_SCHEMA) for (const stamp of v1BackupSets(paths, hashFile(paths.manifestFile))) add(stamp);
  add(readAdoptedRecord(paths)?.migratedFromV1?.backup);
  return [...out];
}

function planReadoption(paths, record, platform) {
  const copy = readBytes(path.join(paths.adoptedDir, "rules", "house-rules.md"));
  if (copy === null) return null;
  const sha = sha256(copy);
  const recorded = record?.adopted?.find((entry) => entry.path === HOUSE_RULES);
  if (recorded?.sha256 && recorded.sha256 !== sha) return { adopted: null, action: null, note: "adopted/rules/house-rules.md does not match its recorded sha256; rules/house-rules.md is left as it is" };
  const target = targetPath(paths, "config", HOUSE_RULES, platform);
  const live = hashFile(target);
  const adopted = [{ path: HOUSE_RULES, sha256: sha }];
  if (live === sha) {
    return {
      adopted,
      action: { base: "config", path: HOUSE_RULES, target, action: "remove", sha256: null, mode: null, bytes: null, drift: false },
      note: "rules/house-rules.md is your adopted original again; it is removed because the wf house rules replace it (uninstall puts it back)"
    };
  }
  if (live === null) return { adopted, action: null, note: null };
  return { adopted, action: null, note: "rules/house-rules.md differs from the adopted original; it is left as it is" };
}

function sameManifest(a, b) {
  if (!a || !b) return false;
  const strip = (value) => JSON.stringify({ ...value, installedAt: null, updatedAt: null });
  return strip(a) === strip(b);
}

export function verifyFiles(paths, build, platform = process.platform) {
  const problems = [];
  for (const file of build.files) {
    const target = targetPath(paths, file.base, file.path, platform);
    const hash = hashFile(target);
    if (hash === null) problems.push(`missing: ${target}`);
    else if (hash !== sha256(contentBytes(file))) problems.push(`content differs: ${target}`);
    else if (platform !== "win32" && fileMode(target) !== (file.mode ?? 0o644)) problems.push(`mode differs: ${target}`);
  }
  return problems;
}

async function confirmed(io, question, { yes, interactive, needsYes = false }) {
  if (yes) return true;
  if (!interactive) {
    if (needsYes) io.print("No terminal to ask in: rerun with --yes.");
    return !needsYes;
  }
  return Boolean(await io.confirm(question));
}

export function prepareInstall({ paths, build, platform = process.platform }) {
  const manifest = readManifest(paths);
  const previous = previousV2(manifest);
  const v1 = manifest.exists && manifest.schema === V1_MANIFEST_SCHEMA ? manifest.data : null;
  const actions = planFiles({ paths, build, previous: previous?.files ?? [], platform });
  const writeTargets = new Set(build.files.map((file) => keyOf(file.base, file.path)));
  const migration = v1 ? planMigration({ paths, v1, writeTargets, platform }) : null;
  const v1Sets = v1 ? v1BackupSets(paths, hashFile(paths.manifestFile)) : [];
  const fallback = manifest.exists ? null : readAdoptedRecord(paths);
  const readopt = manifest.exists ? null : planReadoption(paths, fallback, platform);
  const notes = [];
  if (readopt?.action) actions.push(readopt.action);
  if (readopt?.note) notes.push(readopt.note);
  const fileChanges = actions.filter((item) => item.action !== "unchanged");
  const changes = fileChanges.length + (migration ? migration.changeCount : 0);
  return { manifest, previous, v1, v1Sets, fallback, readopt, notes, actions, migration, fileChanges, changes };
}

function installOps(prepared, paths, platform) {
  const ops = [];
  if (prepared.migration) ops.push(...migrationOps(prepared.migration, { paths, platform }));
  for (const item of prepared.fileChanges) ops.push({ target: item.target, op: item.action === "remove" ? "remove" : "write" });
  ops.push({ target: paths.manifestFile, op: "write" });
  if (prepared.migration) ops.push({ target: targetPath(paths, "config", ADOPTED_RECORD_REL, platform), op: "write" });
  return ops;
}

export function preflight(ops, guard) {
  const problems = [];
  for (const { target, op } of ops) {
    const reason = preflightTarget(target, op, guard);
    if (reason !== null && !problems.includes(reason)) problems.push(reason);
  }
  return problems;
}

function safeBackup(args) {
  try {
    return createBackup(args);
  } catch (error) {
    throw new WfError(`could not write the backup set (${error instanceof Error ? error.message : String(error)}); nothing else was written`);
  }
}

export function putBack(paths, guard, stamp, platform = process.platform) {
  const failures = [];
  let set;
  try {
    set = readBackup(paths, stamp);
  } catch (error) {
    return [`backup ${stamp}: ${error.message}`];
  }
  for (const entry of set.index.entries) {
    if (!isPlainObject(entry) || (entry.base !== "config" && entry.base !== "launcher") || typeof entry.path !== "string") continue;
    const target = targetPath(paths, entry.base, entry.path, platform);
    try {
      if (entry.sha256) {
        if (hashFile(target) === entry.sha256) continue;
        const bytes = readBytes(backupCopyPath(set.dir, entry.base, entry.path));
        if (bytes === null || sha256(bytes) !== entry.sha256) {
          failures.push(`${entry.path}: the backup copy is missing or damaged`);
          continue;
        }
        atomicWrite(target, bytes, { guard, mode: entry.mode ? parseMode(entry.mode) : undefined });
      } else if (hashFile(target) !== null) {
        removeFile(target, guard);
        if (entry.base === "config" && target.startsWith(paths.appDir + path.sep)) removeEmptyDirs(path.dirname(target), paths.appDir, guard);
      }
    } catch (error) {
      failures.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function failedAfterBackup(error, { paths, guard, platform, stamp }) {
  const cause = error instanceof Error ? error.message : String(error);
  const failures = putBack(paths, guard, stamp, platform);
  if (failures.length === 0) return new WfError(`install failed after the backup: ${cause}. Everything was put back from backup ${stamp}, so nothing changed; fix the cause and rerun install.`);
  return new WfError(`install failed after the backup: ${cause}. Putting the files back failed too (${failures.slice(0, 3).join("; ")}): run node wf.mjs restore --to ${stamp} to bring back the state before this install.`);
}

function completeRecord(record, prepared, paths, platform) {
  const stamp = prepared.v1Sets[0];
  if (!stamp) return record;
  const earlier = earlierMigration(paths, stamp, { v1: prepared.v1, platform });
  if (!earlier) return record;
  const removed = [...new Set([...earlier.removed, ...record.removed])];
  let settings = record.settings;
  if (earlier.settings && !(settings?.removed?.length > 0)) settings = { removed: earlier.settings.removed, kept: settings?.kept ?? earlier.settings.kept };
  return { ...record, removed, settings };
}

export async function install(options) {
  const {
    paths,
    build,
    selection,
    choices = null,
    skills,
    repoRoot,
    nodePath,
    claudeVersion = null,
    platform = process.platform,
    env = process.env,
    dryRun = false,
    yes = false,
    interactive = false,
    io,
    now = new Date(),
    validate = null,
    ui = PLAIN_UI,
    announced = false
  } = options;
  const guard = createGuard(paths, platform);
  const prepared = prepareInstall({ paths, build, platform });
  const { previous, migration, fileChanges } = prepared;
  let changes = prepared.changes;
  if (!announced) say(io, reportLines(paths, prepared, ui));
  const manifestFor = (record) =>
    buildManifest({
      previous,
      paths,
      build,
      selection,
      choices,
      skills,
      repoRoot,
      nodePath,
      claudeVersion,
      platform,
      migration: migration ? { adopted: migration.adopted, record } : null,
      fallback: prepared.fallback,
      readopted: prepared.readopt?.adopted ?? null,
      now
    });
  const draft = manifestFor(null);
  const manifestChanged = !sameManifest(previous, draft);
  const problems = changes > 0 || manifestChanged || migration ? preflight(installOps(prepared, paths, platform), guard) : [];
  if (dryRun) {
    for (const problem of problems) say(io, ui.status("fail", `would fail: ${problem}`));
    say(io, ui.status("info", `Dry run: ${changes} changes, nothing written.`));
    return { code: problems.length > 0 ? EXIT.PROBLEMS : EXIT.OK, changes, prepared, written: false };
  }
  if (problems.length > 0) {
    throw new WfError(`cannot install: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}. Nothing was written.`);
  }
  let backup = null;
  if (changes === 0) {
    if (migration) {
      const stamp = prepared.v1Sets[0] ?? safeBackup({ paths, guard, command: "install", entries: [{ base: "config", path: MANIFEST_REL, action: "update" }], now, platform, protect: keepSets(paths) }).stamp;
      try {
        const record = completeRecord(applyMigration(migration, { paths, guard, platform, backupStamp: stamp, now }), prepared, paths, platform);
        writeManifest(paths, manifestFor(record), guard);
        writeAdoptedRecord(paths, guard, migration.adopted, record);
      } catch (error) {
        throw new WfError(`install failed while finishing the v1 migration: ${error instanceof Error ? error.message : String(error)}. Backup ${stamp} holds the v1 manifest (node wf.mjs restore --to ${stamp}).`);
      }
    } else if (manifestChanged) {
      writeManifest(paths, draft, guard);
    }
    say(io, ui.status("ok", `0 changes: wf is up to date${manifestChanged ? " (manifest refreshed)" : ""}.`));
  } else {
    if (!(await confirmed(io, `Apply ${changes} changes?`, { yes, interactive }))) {
      say(io, ui.status("info", "Nothing written."));
      return { code: EXIT.PROBLEMS, changes, prepared, written: false };
    }
    if (migration && refreshSettings(migration, { paths, platform })) {
      const text = "settings.json changed while waiting for the answer; the migration was recomputed on the current file.";
      say(io, ui.status("warn", text, { plain: `note: ${text}` }));
      changes = fileChanges.length + migration.changeCount;
    }
    const entries = [
      ...(migration ? migration.backupEntries : []),
      ...fileChanges.map((item) => ({ base: item.base, path: item.path, action: item.action })),
      { base: "config", path: MANIFEST_REL, action: prepared.manifest.exists ? "update" : "create" },
      ...(migration ? [{ base: "config", path: ADOPTED_RECORD_REL, action: hashFile(targetPath(paths, "config", ADOPTED_RECORD_REL, platform)) === null ? "create" : "update" }] : [])
    ];
    backup = safeBackup({ paths, guard, command: "install", entries, now, platform, protect: keepSets(paths) });
    try {
      let record = null;
      if (migration) record = completeRecord(applyMigration(migration, { paths, guard, platform, backupStamp: prepared.v1Sets[0] ?? backup.stamp, now }), prepared, paths, platform);
      for (const item of fileChanges) {
        if (item.action === "remove") {
          removeFile(item.target, guard);
          if (item.base === "config") removeEmptyDirs(path.dirname(item.target), paths.appDir, guard);
        } else {
          atomicWrite(item.target, item.bytes, { guard, mode: item.mode });
        }
      }
      writeManifest(paths, migration ? manifestFor(record) : draft, guard);
      if (migration) writeAdoptedRecord(paths, guard, migration.adopted, record);
    } catch (error) {
      throw failedAfterBackup(error, { paths, guard, platform, stamp: backup.stamp });
    }
    say(io, ui.status("ok", `Applied ${changes} changes. Backup: ${backup.stamp} (node wf.mjs restore puts it back).`));
  }
  const mismatches = verifyFiles(paths, build, platform);
  for (const problem of mismatches.slice(0, 5)) say(io, ui.status("fail", `verify: ${problem}`));
  let validation = null;
  if (typeof validate === "function") {
    validation = await validate(paths.pluginDir);
    if (validation?.ran) say(io, validation.ok ? ui.status("ok", `verify: ${validation.detail}`) : ui.status("fail", `verify: ${validation.detail} (not rolled back)`));
  }
  if (mismatches.length === 0) say(io, ui.status("ok", `verify: ${build.files.length} files match.`));
  if (!onPath(paths.launcherDir, { env, platform })) say(io, ui.status("warn", pathHint(paths.launcherDir, { env, platform }), { wrap: false }));
  const ok = mismatches.length === 0 && (!validation || !validation.ran || validation.ok);
  if (ok) say(io, ui.rich ? ["", `${MARGIN}${ui.paint("bold cyan", "Next:")} ${NEXT_HINT.slice("Next: ".length)}`, ""] : [NEXT_HINT]);
  return { code: ok ? EXIT.OK : EXIT.PROBLEMS, changes, prepared, backup, problems: mismatches, validation, written: changes > 0 || manifestChanged };
}

export function diff({ paths, build, platform = process.platform, io, ui = PLAIN_UI }) {
  const prepared = prepareInstall({ paths, build, platform });
  if (prepared.migration) say(io, migrationBlock(prepared.migration, ui));
  io.print(ui.rich ? `${MARGIN}${ui.paint("bold", "Plan")}  ${prepared.changes} changes against ${paths.configHome}` : `Plan: ${prepared.changes} changes against ${paths.configHome}`);
  for (const item of prepared.actions) {
    if (item.action === "unchanged") continue;
    let detail = "";
    if (item.action === "update") {
      const { added, removed } = lineDiffCounts(readText(item.target), item.bytes.toString("utf8"));
      detail = ` (+${added} -${removed} lines${item.drift ? ", changed since the last install" : ""})`;
    } else if (item.action === "create") {
      detail = ` (${item.bytes.toString("utf8").split("\n").length} lines)`;
    }
    if (ui.rich) io.print(ui.fit([{ text: `${MARGIN}  ` }, { text: `${ui.sym(item.action)} ${item.action.padEnd(6)}`, style: PLAN_STYLES[item.action] }, { text: `  ${display(paths, item)}${detail}` }]));
    else io.print(`  ${item.action.padEnd(6)}  ${display(paths, item)}${detail}`);
  }
  if (prepared.changes === 0) say(io, ui.status("ok", "0 changes: wf is up to date."));
  return { code: EXIT.OK, changes: prepared.changes, prepared };
}

export function uninstallTargets(paths, data, platform = process.platform) {
  const seen = new Set();
  const out = [];
  const add = (base, rel) => {
    const key = keyOf(base, rel);
    if (seen.has(key)) return;
    seen.add(key);
    if (hashFile(targetPath(paths, base, rel, platform)) !== null) out.push({ base, path: rel, action: "remove" });
  };
  for (const entry of Array.isArray(data.files) ? data.files : []) if (isPlainObject(entry)) add(entry.base, entry.path);
  for (const rel of listFiles(paths.pluginDir)) add("config", `ai-agents-setup/plugin/${rel}`);
  add("config", "ai-agents-setup/wf-settings.json");
  for (const rel of listFiles(paths.stateDir)) add("config", `ai-agents-setup/state/${rel}`);
  add("config", MANIFEST_REL);
  return out;
}

export async function uninstall({ paths, platform = process.platform, yes = false, interactive = false, io, now = new Date() }) {
  const guard = createGuard(paths, platform);
  const manifest = readManifest(paths);
  if (!manifest.exists) {
    io.print(`wf is not installed in ${paths.configHome} (no manifest). Nothing to do.`);
    return { code: EXIT.OK, removed: 0 };
  }
  if (manifest.schema === V1_MANIFEST_SCHEMA) {
    io.print("A v1 install is present. Run node wf.mjs install first (it migrates v1), then uninstall.");
    return { code: EXIT.PROBLEMS, removed: 0 };
  }
  if (manifest.schema !== MANIFEST_SCHEMA) throw new WfError(`unknown manifest schema ${manifest.schema}; nothing was removed`);
  const targets = uninstallTargets(paths, manifest.data, platform);
  const adoptedRules = path.join(paths.adoptedDir, "rules", "house-rules.md");
  const liveRules = path.join(paths.rulesDir, "house-rules.md");
  const record = (manifest.data.adopted ?? []).find((entry) => entry?.path === "rules/house-rules.md");
  const original = readBytes(adoptedRules);
  let restoreRules = null;
  if (original !== null) {
    const originalSha = sha256(original);
    const liveSha = hashFile(liveRules);
    if (record?.sha256 && record.sha256 !== originalSha) io.print("note: adopted/rules/house-rules.md does not match its recorded sha256; it is not restored");
    else if (liveSha === null) restoreRules = original;
    else if (liveSha !== originalSha) io.print("note: rules/house-rules.md already exists and differs from the adopted original; it is left as it is");
  }
  io.print(`Uninstall from ${paths.configHome}:`);
  io.print(`  remove ${targets.length} files: ${summarizePaths(targets.map((item) => display(paths, item)), 6).join(", ")}`);
  if (restoreRules) io.print("  restore rules/house-rules.md from adopted/");
  io.print("  keep: ai-agents-setup/backups/, ai-agents-setup/adopted/");
  if (!(await confirmed(io, "Uninstall wf?", { yes, interactive, needsYes: true }))) {
    io.print("Nothing removed.");
    return { code: EXIT.PROBLEMS, removed: 0 };
  }
  const entries = [...targets];
  if (restoreRules) entries.push({ base: "config", path: "rules/house-rules.md", action: "create" });
  const backup = createBackup({ paths, guard, command: "uninstall", entries, now, platform, protect: keepSets(paths) });
  let removed = 0;
  for (const item of targets) if (removeFile(targetPath(paths, item.base, item.path, platform), guard)) removed += 1;
  removeTree(paths.pluginDir, guard);
  removeTree(paths.stateDir, guard);
  if (restoreRules) atomicWrite(liveRules, restoreRules, { guard, mode: 0o644 });
  io.print(`Removed ${removed} files${restoreRules ? " and restored rules/house-rules.md" : ""}. Backup: ${backup.stamp} (node wf.mjs restore puts it back).`);
  return { code: EXIT.OK, removed, backup };
}

export async function restore({ paths, to = null, platform = process.platform, yes = false, interactive = false, io, now = new Date() }) {
  const guard = createGuard(paths, platform);
  const sets = listBackups(paths);
  if (sets.length === 0) {
    io.print(`No backup sets in ${paths.backupsDir}.`);
    return { code: EXIT.PROBLEMS };
  }
  const stamp = to ?? sets[sets.length - 1];
  if (!sets.includes(stamp)) {
    io.print(`No backup set ${stamp}. Available: ${sets.join(", ")}`);
    return { code: EXIT.USAGE };
  }
  const { dir, index } = readBackup(paths, stamp);
  const writes = [];
  const removes = [];
  const skipped = [];
  for (const entry of index.entries) {
    if (!isPlainObject(entry) || (entry.base !== "config" && entry.base !== "launcher") || typeof entry.path !== "string") continue;
    const target = targetPath(paths, entry.base, entry.path, platform);
    const reason = guard.check(target, entry.sha256 ? "write" : "remove");
    if (reason !== null) {
      skipped.push(`${display(paths, entry)}: ${reason}`);
      continue;
    }
    if (entry.sha256) {
      const bytes = readBytes(backupCopyPath(dir, entry.base, entry.path));
      if (bytes === null || sha256(bytes) !== entry.sha256) {
        skipped.push(`${display(paths, entry)}: the backup copy is missing or damaged`);
        continue;
      }
      if (hashFile(target) === entry.sha256) continue;
      const mode = entry.mode ? parseMode(entry.mode) : fileMode(target) ?? (entry.base === "launcher" ? 0o755 : 0o644);
      writes.push({ base: entry.base, path: entry.path, target, bytes, mode, action: hashFile(target) === null ? "create" : "update" });
    } else if (hashFile(target) !== null) {
      removes.push({ base: entry.base, path: entry.path, target, action: "remove" });
    }
  }
  io.print(`Restore backup ${stamp} (${index.command ?? "unknown"} at ${index.createdAt ?? "?"}): put back ${writes.length} files, remove ${removes.length} files.`);
  for (const line of summarizePaths([...writes, ...removes].map((item) => `${item.action} ${display(paths, item)}`), 10)) io.print(`  ${line}`);
  for (const line of skipped) io.print(`  skip ${line}`);
  if (writes.length + removes.length === 0) {
    io.print("Nothing to restore: the files already match the backup.");
    return { code: skipped.length > 0 ? EXIT.PROBLEMS : EXIT.OK, stamp, written: 0, removed: 0, skipped };
  }
  if (!(await confirmed(io, `Restore ${stamp}?`, { yes, interactive, needsYes: true }))) {
    io.print("Nothing restored.");
    return { code: EXIT.PROBLEMS, stamp };
  }
  const backup = createBackup({ paths, guard, command: "restore", entries: [...writes, ...removes].map((item) => ({ base: item.base, path: item.path, action: item.action })), now, platform, keep: Infinity });
  for (const item of writes) atomicWrite(item.target, item.bytes, { guard, mode: item.mode });
  for (const item of removes) {
    removeFile(item.target, guard);
    if (item.base === "config" && item.target.startsWith(paths.appDir + path.sep)) removeEmptyDirs(path.dirname(item.target), paths.appDir, guard);
  }
  pruneBackups(paths, guard, undefined, keepSets(paths));
  io.print(`Restored ${stamp}: ${writes.length} written, ${removes.length} removed. The state before this restore is in backup ${backup.stamp}. Run node wf.mjs doctor to check.`);
  return { code: skipped.length > 0 ? EXIT.PROBLEMS : EXIT.OK, stamp, written: writes.length, removed: removes.length, skipped, backup };
}
