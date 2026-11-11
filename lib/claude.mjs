import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { compareVersions, foldsCase, pathApi } from "./core.mjs";

export const DEFAULT_MIN_VERSION = "2.1.312";
const TIMEOUT_MS = 30000;
const SESSION_KEYS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PROJECT_DIR"
]);

function envValue(env, name, platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function childEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SESSION_KEYS.includes(key) || key.startsWith("CLAUDE_CODE_SESSION_")) continue;
    out[key] = value;
  }
  return out;
}

export function pathEntries({ env = process.env, platform = process.platform } = {}) {
  const raw = envValue(env, "PATH", platform) ?? "";
  return raw
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

function executable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const SHIM_FILE = /\.(cmd|bat|ps1)$/i;

export function whichAll(name, { env = process.env, platform = process.platform, isExecutable = executable } = {}) {
  const api = pathApi(platform);
  const exts = platform === "win32" ? (envValue(env, "PATHEXT", platform) ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const out = [];
  for (const dir of pathEntries({ env, platform })) {
    if (!api.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = api.join(dir, name + ext.toLowerCase());
      if (isExecutable(file, platform) && !out.includes(file)) out.push(file);
    }
  }
  return out;
}

export function which(name, options = {}) {
  return whichAll(name, options)[0] ?? null;
}

export function findClaude({ env = process.env, platform = process.platform, nodePath = process.execPath, isExecutable = executable } = {}) {
  const override = env.WF_CLAUDE_BIN;
  if (typeof override === "string" && override !== "") {
    if (/\.(mjs|js)$/i.test(override)) return { command: nodePath, args: [override], path: override };
    return { command: override, args: [], path: override };
  }
  const found = whichAll("claude", { env, platform, isExecutable });
  const usable = platform === "win32" ? found.find((file) => !SHIM_FILE.test(file)) : found[0];
  if (usable) return { command: usable, args: [], path: usable };
  const shim = found.find((file) => SHIM_FILE.test(file));
  return shim ? { command: null, args: [], path: shim, shim: true } : null;
}

export function runClaude(bin, args, { env = process.env, cwd, timeoutMs = TIMEOUT_MS } = {}) {
  const result = spawnSync(bin.command, [...bin.args, ...args], {
    env: childEnv(env),
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 16 * 1024 * 1024
  });
  return {
    status: typeof result.status === "number" ? result.status : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? result.error.message : null
  };
}

export function parseVersionOutput(text) {
  const match = /(\d+\.\d+\.\d+)\s*\(Claude Code\)/.exec(String(text ?? ""));
  if (match) return match[1];
  const plain = /^\s*(\d+\.\d+\.\d+)\s*$/m.exec(String(text ?? ""));
  return plain ? plain[1] : null;
}

export function checkClaude({ env = process.env, platform = process.platform, minVersion = DEFAULT_MIN_VERSION, nodePath, isExecutable } = {}) {
  const bin = findClaude({ env, platform, nodePath, ...(isExecutable ? { isExecutable } : {}) });
  if (!bin) {
    return { ok: false, found: false, version: null, minVersion, bin: null, message: "Claude Code not found on PATH. Install it (https://code.claude.com/docs), then rerun." };
  }
  if (bin.shim) {
    return {
      ok: false,
      found: true,
      version: null,
      minVersion,
      bin: null,
      message: `found only ${bin.path}, an npm shim that Node cannot start without a shell. Install the native Claude Code (in PowerShell: irm https://claude.ai/install.ps1 | iex), or set WF_CLAUDE_BIN to a claude.exe, then rerun.`
    };
  }
  const result = runClaude(bin, ["--version"], { env });
  const version = parseVersionOutput(result.stdout);
  if (!version) {
    const cause = result.error ?? (result.status !== 0 && result.status !== null ? `exit ${result.status}` : null);
    return { ok: false, found: true, version: null, minVersion, bin, message: `could not read the Claude Code version from ${bin.path} --version${cause ? ` (${cause})` : ""}` };
  }
  if (compareVersions(version, minVersion) < 0) {
    return { ok: false, found: true, version, minVersion, bin, message: `Claude Code ${version} is older than ${minVersion}. Run: claude update` };
  }
  return { ok: true, found: true, version, minVersion, bin, message: `Claude Code ${version}` };
}

export function hasPluginValidate(bin, { env = process.env } = {}) {
  if (!bin) return false;
  const result = runClaude(bin, ["plugin", "validate", "--help"], { env });
  return result.status === 0 && /plugin validate/.test(result.stdout + result.stderr);
}

export function validatePlugin(bin, pluginDir, { env = process.env } = {}) {
  if (!hasPluginValidate(bin, { env })) return { ran: false, ok: true, detail: "claude plugin validate is not available" };
  const result = runClaude(bin, ["plugin", "validate", pluginDir, "--json"], { env });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {}
  const errors = [];
  if (report && report.manifest && Array.isArray(report.manifest.errors)) errors.push(...report.manifest.errors.map((item) => item.message ?? String(item)));
  for (const item of Array.isArray(report?.contents) ? report.contents : []) {
    if (Array.isArray(item?.errors)) errors.push(...item.errors.map((error) => `${item.file ?? item.path ?? ""} ${error.message ?? String(error)}`.trim()));
  }
  const ok = result.status === 0 && (report === null || report.success !== false);
  const detail = ok ? "claude plugin validate passed" : `claude plugin validate failed: ${errors.slice(0, 3).join("; ") || (result.stderr || result.stdout).trim().split("\n").slice(0, 3).join(" ")}`;
  return { ran: true, ok, detail };
}

export function onPath(dir, { env = process.env, platform = process.platform } = {}) {
  const api = pathApi(platform);
  const fold = foldsCase(platform);
  const norm = (value) => {
    let out = api.normalize(value);
    while (out.length > 1 && /[\\/]$/.test(out)) out = out.slice(0, -1);
    return fold ? out.toLowerCase() : out;
  };
  const wanted = norm(dir);
  return pathEntries({ env, platform }).some((entry) => api.isAbsolute(entry) && norm(entry) === wanted);
}

function powershellQuote(text) {
  return `'${String(text).replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
}

function shSingleQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

export function shellRcFile({ env = process.env, platform = process.platform } = {}) {
  const shell = String(env.SHELL ?? "");
  if (shell.endsWith("zsh")) return "~/.zshrc";
  if (shell.endsWith("bash")) return platform === "darwin" ? "~/.bash_profile" : "~/.bashrc";
  return "~/.profile";
}

export function pathHint(dir, { env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") {
    return `${dir} is not on PATH. Add it in PowerShell: [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ${powershellQuote(`;${dir}`)}, 'User'), then open a new terminal.`;
  }
  const line = `export PATH="${String(dir).replace(/[\\"$`]/g, "\\$&")}:$PATH"`;
  return `${dir} is not on PATH. Add it: echo ${shSingleQuote(line)} >> ${shellRcFile({ env, platform })}, then open a new terminal.`;
}
