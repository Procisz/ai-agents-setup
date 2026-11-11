import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "../../../lib/core.mjs";

export const DATA_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(DATA_DIR, "..", "..", "..");
export const FAKE_CLAUDE = path.join(DATA_DIR, "fake-claude.mjs");
export const ROLES = Object.freeze(["orchestrator", "planner", "docs", "coder", "tester", "reviewer", "debugger"]);

export function tmpRoot(prefix = "wf-install-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function cleanup(root) {
  if (root && root.startsWith(fs.realpathSync(os.tmpdir()))) fs.rmSync(root, { recursive: true, force: true });
}

export function makePaths(root, platform = process.platform) {
  return resolvePaths({ configDir: path.join(root, "config"), launcherDir: path.join(root, "launcher"), env: { HOME: path.join(root, "home") }, platform });
}

export function captureIo({ answer = true, selections = null, choices = null, ui = undefined } = {}) {
  const lines = [];
  const questions = [];
  const calls = [];
  return {
    lines,
    questions,
    calls,
    interactive: false,
    ...(ui ? { ui } : {}),
    print: (line) => lines.push(String(line)),
    confirm: async (question) => {
      questions.push(question);
      return answer;
    },
    multiSelect: async (options) => {
      questions.push(options.title);
      calls.push({ kind: "multi", ...options });
      return selections ? selections(options.title, options.items, options) : options.items.filter((item) => item.checked || item.locked).map((item) => item.value);
    },
    select: async (options) => {
      questions.push(options.title);
      calls.push({ kind: "single", ...options });
      return choices ? choices(options.title, options.items, options) : options.items[0]?.value ?? null;
    },
    text: () => lines.join("\n")
  };
}

export function scriptedSelections(answers) {
  const queue = [...answers];
  return (title, items) => {
    const next = queue.shift();
    const ticked = items.filter((item) => item.checked || item.locked).map((item) => item.value);
    if (next === undefined) return ticked;
    return typeof next === "function" ? next(ticked, items, title) : next;
  };
}

function hookFile(name) {
  return fs.readFileSync(path.join(DATA_DIR, "hooks", name), "utf8");
}

export function fakeBuild(paths, { agentBody = "body", extra = [], omit = [], house = "# House rules\n\nThe v2 house rules.\n" } = {}) {
  const agents = ["orchestrator", "coder-t1", "coder-t2", "tester-t1"];
  const files = [
    ...agents.map((name) => ({ base: "config", path: `ai-agents-setup/plugin/agents/${name}.md`, content: `---\nname: ${name}\ndescription: test agent\n---\n\n${agentBody} ${name}\n`, mode: 0o644 })),
    { base: "config", path: "ai-agents-setup/plugin/.claude-plugin/plugin.json", content: '{\n  "name": "wf",\n  "version": "2.0.0"\n}\n', mode: 0o644 },
    { base: "config", path: "ai-agents-setup/plugin/library/seo/SKILL.md", content: "---\nname: seo\ndescription: test skill\n---\n\nSEO body.\n", mode: 0o644 },
    { base: "config", path: "ai-agents-setup/plugin/hooks/guard.mjs", content: hookFile("guard.mjs"), mode: 0o644 },
    { base: "config", path: "ai-agents-setup/plugin/hooks/context.mjs", content: hookFile("context.mjs"), mode: 0o644 },
    { base: "config", path: "ai-agents-setup/plugin/hooks/compact.mjs", content: hookFile("compact.mjs"), mode: 0o644 },
    { base: "config", path: "ai-agents-setup/plugin/hooks/config.json", content: JSON.stringify({ window: 1000000, warnTokens: 500000, handoffTokens: 800000, compactTokens: 850000, stateDir: paths.stateDir }, null, 2) + "\n", mode: 0o644 },
    { base: "config", path: "ai-agents-setup/plugin/bin/wf-clean", content: `#!/bin/sh\nexec "${process.execPath}" "${paths.pluginDir}/scripts/wf-clean.mjs" "$@"\n`, mode: 0o755 },
    { base: "config", path: "ai-agents-setup/wf-settings.json", content: '{\n  "permissions": {\n    "deny": ["Agent(model:*)", "Agent(effort:*)"]\n  }\n}\n', mode: 0o644 },
    { base: "config", path: "rules/wf-house-rules.md", content: house, mode: 0o644 },
    { base: "launcher", path: "wf", content: `#!/bin/sh\nexport CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='86.74'\nexec claude --plugin-dir '${paths.pluginDir}' --agent wf:orchestrator "$@"\n`, mode: 0o755 },
    ...extra
  ].filter((file) => !omit.includes(file.path));
  return { files, agents: agents.map((name) => ({ name, role: name.split("-")[0], tier: name.includes("-t") ? name.slice(-2).toUpperCase() : "main", model: "claude-sonnet-5-5", effort: "medium" })) };
}

export function fakeSelection() {
  return Object.fromEntries(ROLES.map((role) => [role, role === "reviewer" ? ["seo"] : []]));
}

function escapeFor(file, value) {
  return file.endsWith(".json") ? JSON.stringify(value).slice(1, -1) : value;
}

export function copyFixture(name, root, replacements) {
  const source = path.join(DATA_DIR, name);
  const walk = (rel) => {
    const from = path.join(source, rel);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childRel);
        continue;
      }
      const to = path.join(root, childRel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      let text = fs.readFileSync(path.join(source, childRel), "utf8");
      for (const [key, value] of Object.entries(replacements)) text = text.split(key).join(escapeFor(entry.name, value));
      fs.writeFileSync(to, text, { mode: fs.statSync(path.join(source, childRel)).mode & 0o777 });
    }
  };
  walk("");
}

export function installV1Fixture(root) {
  const paths = makePaths(root);
  copyFixture("v1", root, {
    "@@CONFIG@@": paths.configHome,
    "@@LAUNCHER@@": paths.launcherDir,
    "@@NODE@@": process.execPath,
    "@@HOME@@": path.join(root, "home"),
    "@@REPO@@": REPO_ROOT
  });
  return paths;
}

export function snapshot(dir) {
  const out = {};
  const walk = (folder, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), rel);
      else out[rel] = fs.readFileSync(path.join(folder, entry.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}
