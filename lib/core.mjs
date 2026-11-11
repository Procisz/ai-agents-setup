import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const APP_DIR = "ai-agents-setup";
export const MANIFEST_SCHEMA = "wf.manifest/2";
export const V1_MANIFEST_SCHEMA = "wf.manifest/1";
export const BACKUP_SCHEMA = "wf.backup/2";
export const KEEP_BACKUPS = 5;
export const LAUNCHER_FILES = Object.freeze(["wf", "wf.cmd"]);

export const EXIT = Object.freeze({ OK: 0, PROBLEMS: 1, USAGE: 2 });

export class WfError extends Error {
  constructor(message, exitCode = EXIT.PROBLEMS) {
    super(message);
    this.name = "WfError";
    this.exitCode = exitCode;
  }
}

export function pathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function foldsCase(platform = process.platform) {
  return platform === "win32" || platform === "darwin";
}

export function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

function trimSeparators(p, api) {
  const root = api.parse(p).root;
  let out = p;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function absolute(value, label, api) {
  if (typeof value !== "string" || value === "" || !api.isAbsolute(value)) {
    throw new WfError(`${label} must be an absolute path: ${value}`, EXIT.USAGE);
  }
  return trimSeparators(api.normalize(value), api);
}

export function resolvePaths({ configDir, launcherDir, env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const api = pathApi(platform);
  const homeVar = platform === "win32" ? env.USERPROFILE : env.HOME;
  const home = typeof homeVar === "string" && api.isAbsolute(homeVar) ? trimSeparators(api.normalize(homeVar), api) : homedir;
  let configHome;
  if (configDir !== undefined && configDir !== null) configHome = absolute(configDir, "--config-dir", api);
  else if (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR !== "") configHome = absolute(env.CLAUDE_CONFIG_DIR, "CLAUDE_CONFIG_DIR", api);
  else configHome = api.join(home, ".claude");
  const launcher = launcherDir !== undefined && launcherDir !== null ? absolute(launcherDir, "--launcher-dir", api) : api.join(home, ".local", "bin");
  const appDir = api.join(configHome, APP_DIR);
  return {
    configHome,
    appDir,
    pluginDir: api.join(appDir, "plugin"),
    stateDir: api.join(appDir, "state"),
    launcherDir: launcher,
    manifestFile: api.join(appDir, "manifest.json"),
    backupsDir: api.join(appDir, "backups"),
    adoptedDir: api.join(appDir, "adopted"),
    rulesDir: api.join(configHome, "rules"),
    settingsFile: api.join(configHome, "settings.json"),
    agentsDir: api.join(configHome, "agents")
  };
}

const CELLAR_NODE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

export function resolveNodePath({ appDir, env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  const api = pathApi(platform);
  if (appDir) {
    const local = readJson(api.join(appDir, "local.json"));
    if (local !== null) {
      if (!isPlainObject(local) || typeof local.nodePath !== "string" || !api.isAbsolute(local.nodePath)) {
        throw new WfError(`${api.join(appDir, "local.json")}: nodePath must be an absolute path`);
      }
      return local.nodePath;
    }
  }
  const match = platform === "win32" ? null : CELLAR_NODE.exec(execPath);
  if (match) {
    const stable = `${match[1]}/opt/${match[2]}/bin/node`;
    if (isFile(stable)) return stable;
  }
  return execPath;
}

export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMissing(error) {
  return Boolean(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function readText(file) {
  const bytes = readBytes(file);
  return bytes === null ? null : bytes.toString("utf8");
}

export function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new WfError(`${file} is not valid JSON: ${error.message}`);
  }
}

export function hashFile(file) {
  const bytes = readBytes(file);
  return bytes === null ? null : sha256(bytes);
}

export function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

export function formatJson(value, indent = 2) {
  return JSON.stringify(value, null, indent) + "\n";
}

export function modeText(mode) {
  return (mode ?? 0o644).toString(8);
}

export function parseMode(text) {
  if (typeof text === "number") return text;
  const value = Number.parseInt(String(text ?? "644"), 8);
  return Number.isInteger(value) ? value : 0o644;
}

export function targetPath(paths, base, rel, platform = process.platform) {
  const api = pathApi(platform);
  const root = base === "launcher" ? paths.launcherDir : paths.configHome;
  return api.join(root, ...String(rel).split("/"));
}

function relativeInside(api, root, target, fold) {
  const rel = api.relative(fold ? root.toLowerCase() : root, fold ? target.toLowerCase() : target);
  if (rel === "") return "";
  if (rel.startsWith("..") || api.isAbsolute(rel)) return null;
  return toPosix(target.slice(target.length - rel.length));
}

const CONFIG_FILES = Object.freeze(["rules/wf-house-rules.md", "rules/house-rules.md", "agents/Explore.md", "settings.json"]);
const CONFIG_DIRS = Object.freeze(["", "rules", "agents"]);
const V1_AGENT = /^agents\/wf-[^/]+\.md$/;

export function createGuard(paths, platform = process.platform) {
  const api = pathApi(platform);
  const fold = foldsCase(platform);
  const same = (a, b) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  const appPrefix = `${APP_DIR}/`;

  function check(target, op) {
    if (typeof target !== "string" || !api.isAbsolute(target)) return `not an absolute path: ${target}`;
    const abs = api.normalize(target);
    const relLauncher = relativeInside(api, paths.launcherDir, abs, fold);
    if (relLauncher === "" && op === "mkdir") return null;
    if (relLauncher !== null && relLauncher !== "" && !relLauncher.includes("/") && (op === "write" || op === "remove")) {
      if (LAUNCHER_FILES.some((name) => same(name, relLauncher))) return null;
    }
    const rel = relativeInside(api, paths.configHome, abs, fold);
    if (rel === null) return `outside the config home and the launcher files: ${abs}`;
    const inApp = rel.length > appPrefix.length && same(rel.slice(0, appPrefix.length), appPrefix);
    if (op === "mkdir") {
      if (inApp || same(rel, APP_DIR) || CONFIG_DIRS.some((dir) => same(dir, rel))) return null;
      return `not a folder wf creates: ${rel || "<config home>"}`;
    }
    if (op === "rmtree") return inApp ? null : `only folders inside ${APP_DIR}/ may be removed: ${rel || "<config home>"}`;
    if (op !== "write" && op !== "remove") return `unknown operation ${op}`;
    if (inApp) return null;
    if (CONFIG_FILES.some((file) => same(file, rel))) return null;
    if (V1_AGENT.test(fold ? rel.toLowerCase() : rel)) return null;
    return `not a wf path: ${rel || "<config home>"}`;
  }

  function assert(target, op = "write") {
    const reason = check(target, op);
    if (reason !== null) throw new WfError(`refusing to ${op} ${target}: ${reason}`);
    return true;
  }

  return { check, assert };
}

function noSymlink(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new WfError(`refusing to write through a symlink: ${file}`);
    if (!stat.isFile()) throw new WfError(`refusing to replace something that is not a file: ${file}`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export function ensureDir(dir, guard, mode) {
  if (isDir(dir)) return;
  if (guard) guard.assert(dir, "mkdir");
  fs.mkdirSync(dir, mode === undefined ? { recursive: true } : { recursive: true, mode });
}

function nearestExisting(dir) {
  let current = dir;
  for (;;) {
    try {
      return { dir: current, stat: fs.statSync(current) };
    } catch (error) {
      if (!isMissing(error)) return { dir: current, stat: null, error };
    }
    const parent = path.dirname(current);
    if (parent === current) return { dir: current, stat: null };
    current = parent;
  }
}

export function preflightTarget(target, op, guard) {
  const reason = guard ? guard.check(target, op) : null;
  if (reason !== null) return reason;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      if (op !== "remove") return `${target} is a symlink; wf never writes through one`;
    } else if (!stat.isFile()) return `${target} is not a file`;
  } catch (error) {
    if (!isMissing(error)) return `${target} cannot be read: ${error.code ?? error.message}`;
    if (op === "remove") return null;
  }
  const parent = nearestExisting(path.dirname(target));
  if (parent.error) return `${parent.dir} cannot be read: ${parent.error.code ?? parent.error.message}`;
  if (parent.stat === null) return `no existing folder above ${target}`;
  if (!parent.stat.isDirectory()) return `${parent.dir} is not a folder`;
  try {
    fs.accessSync(parent.dir, fs.constants.W_OK);
  } catch {
    return `${parent.dir} is not writable`;
  }
  return null;
}

export function atomicWrite(file, data, { mode, guard } = {}) {
  if (guard) guard.assert(file, "write");
  const exists = noSymlink(file);
  const dir = path.dirname(file);
  ensureDir(dir, guard);
  const finalMode = mode ?? (exists ? fileMode(file) : 0o644);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, buffer, { mode: finalMode, flag: "wx" });
    if (process.platform !== "win32") fs.chmodSync(tmp, finalMode);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw error;
  }
  return sha256(buffer);
}

export function removeFile(file, guard) {
  if (guard) guard.assert(file, "remove");
  try {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) throw new WfError(`refusing to remove a folder as a file: ${file}`);
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export function removeTree(dir, guard) {
  if (guard) guard.assert(dir, "rmtree");
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: false });
  return true;
}

export function removeEmptyDirs(dir, stopAt, guard) {
  let current = dir;
  const stop = path.normalize(stopAt);
  while (current.length > stop.length && current.startsWith(stop)) {
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    if (guard) guard.assert(current, "rmtree");
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

export function listFiles(dir) {
  const out = [];
  const walk = (folder, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

export function utcStamp(date = new Date()) {
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function isoTime(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const STAMP = /^(\d{8}T\d{6}Z)(?:-(\d+))?$/;

function stampKey(name) {
  const match = STAMP.exec(name);
  return match ? [match[1], Number(match[2] ?? 0)] : null;
}

export function listBackups(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.backupsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => stampKey(name) && isFile(path.join(paths.backupsDir, name, "index.json")))
    .sort((a, b) => {
      const [sa, na] = stampKey(a);
      const [sb, nb] = stampKey(b);
      return sa === sb ? na - nb : sa < sb ? -1 : 1;
    });
}

export function readBackup(paths, stamp) {
  const dir = path.join(paths.backupsDir, stamp);
  const index = readJson(path.join(dir, "index.json"));
  if (!isPlainObject(index) || !Array.isArray(index.entries)) throw new WfError(`backup ${stamp} has no valid index.json`);
  return { stamp, dir, index };
}

export function backupCopyPath(dir, base, rel) {
  return path.join(dir, "files", base, ...String(rel).split("/"));
}

export const BACKUP_FILE_MODE = 0o600;
export const BACKUP_DIR_MODE = 0o700;

export function createBackup({ paths, guard, command, entries, now = new Date(), platform = process.platform, keep = KEEP_BACKUPS, protect = [] }) {
  const base = utcStamp(now);
  let existing = [];
  try {
    existing = fs.readdirSync(paths.backupsDir);
  } catch {}
  const taken = existing.map(stampKey).filter((key) => key && key[0] === base).map((key) => Math.max(1, key[1]));
  const stamp = taken.length === 0 ? base : `${base}-${Math.max(...taken) + 1}`;
  const dir = path.join(paths.backupsDir, stamp);
  const index = {
    schema: BACKUP_SCHEMA,
    stamp,
    createdAt: isoTime(now),
    command,
    platform,
    configHome: paths.configHome,
    launcherDir: paths.launcherDir,
    entries: []
  };
  ensureDir(paths.backupsDir, guard);
  ensureDir(dir, guard, BACKUP_DIR_MODE);
  atomicWrite(path.join(dir, "index.json"), formatJson({ ...index, partial: true }), { guard, mode: BACKUP_FILE_MODE });
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.base}:${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = targetPath(paths, entry.base, entry.path, platform);
    const bytes = readBytes(file);
    const item = { base: entry.base, path: entry.path, action: entry.action, sha256: bytes === null ? null : sha256(bytes) };
    if (bytes !== null) {
      item.mode = modeText(fileMode(file));
      atomicWrite(backupCopyPath(dir, entry.base, entry.path), bytes, { guard, mode: BACKUP_FILE_MODE });
    }
    index.entries.push(item);
  }
  atomicWrite(path.join(dir, "index.json"), formatJson(index), { guard, mode: BACKUP_FILE_MODE });
  const pruned = pruneBackups(paths, guard, keep, protect);
  return { stamp, dir, index, pruned };
}

export function pruneBackups(paths, guard, keep = KEEP_BACKUPS, protect = []) {
  const sets = listBackups(paths).filter((stamp) => !protect.includes(stamp));
  const pruned = [];
  while (sets.length > keep) {
    const stamp = sets.shift();
    removeTree(path.join(paths.backupsDir, stamp), guard);
    pruned.push(stamp);
  }
  return pruned;
}

export function readManifest(paths) {
  const data = readJson(paths.manifestFile);
  if (data === null) return { exists: false, schema: null, data: null };
  if (!isPlainObject(data)) throw new WfError(`${paths.manifestFile} must hold a JSON object`);
  return { exists: true, schema: data.schema ?? null, data };
}

export function writeManifest(paths, data, guard) {
  return atomicWrite(paths.manifestFile, formatJson(data), { guard });
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

export function summarizePaths(list, limit = 8) {
  if (list.length <= limit) return list;
  const dirOf = (item) => (item.includes("/") ? item.slice(0, item.lastIndexOf("/")) : "");
  const maxDepth = Math.max(1, ...list.map((item) => dirOf(item).split("/").length));
  for (let depth = maxDepth; depth >= 1; depth -= 1) {
    const groups = new Map();
    for (const item of list) {
      const dir = dirOf(item);
      const key = dir === "" ? item : dir.split("/").slice(0, depth).join("/");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    if (groups.size <= limit || depth === 1) return [...groups.entries()].map(([key, items]) => (items.length === 1 ? items[0] : `${key}/ (${items.length} files)`));
  }
  return list;
}
