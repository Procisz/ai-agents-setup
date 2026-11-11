import fs from "node:fs";
import path from "node:path";
import { SESSION_ID, isEntry, loadConfig, taskOwnership } from "../hooks/context.mjs";

const USAGE = "usage: wf-clean [--force] <absolute task folder>";
const MARKERS = ["summary.md", "progress.md"];

function refuse(reason) {
  return { code: 2, lines: [], error: `wf-clean: refused: ${reason}` };
}

export function clean(argv, { env = process.env, config = null, now = Date.now() } = {}) {
  const force = argv.includes("--force");
  const paths = argv.filter((arg) => arg !== "--force");
  if (paths.length !== 1 || typeof paths[0] !== "string" || paths[0].trim() === "") return refuse(`expected one argument\n${USAGE}`);
  const target = paths[0];
  if (!path.isAbsolute(target)) return refuse(`${target} is not an absolute path`);
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    return refuse(`${target} does not exist`);
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return refuse(`${target} cannot be read`);
  }
  if (!stat.isDirectory()) return refuse(`${real} is not a folder`);
  const work = path.dirname(real);
  if (path.basename(work) !== ".work" || path.dirname(work) === work) return refuse(`${real} is not a task folder <project>/.work/<name>`);
  if (!MARKERS.some((name) => fs.existsSync(path.join(real, name)))) return refuse(`${real} holds neither summary.md nor progress.md`);
  if (!force) {
    const session = typeof env.CLAUDE_CODE_SESSION_ID === "string" && SESSION_ID.test(env.CLAUDE_CODE_SESSION_ID) ? env.CLAUDE_CODE_SESSION_ID : null;
    const owner = taskOwnership(real, { stateDir: (config ?? loadConfig({ env })).stateDir, sessionId: session, now });
    if (owner.state === "live") return refuse(`${real} belongs to session ${owner.owner}, which was active ${Math.floor(owner.activity.ageMs / 60000)} min ago; it may still be running (add --force to delete it anyway)`);
  }
  fs.rmSync(real, { recursive: true, force: true });
  const lines = [`wf-clean: removed ${real}`];
  let rest = [];
  try {
    rest = fs.readdirSync(work);
  } catch {
    return { code: 0, lines, error: null };
  }
  if (rest.every((name) => name === ".gitignore")) {
    fs.rmSync(work, { recursive: true, force: true });
    lines.push(`wf-clean: removed ${work}`);
  }
  return { code: 0, lines, error: null };
}

if (isEntry(import.meta.url)) {
  const result = clean(process.argv.slice(2));
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (result.error) process.stderr.write(`${result.error}\n`);
  process.exitCode = result.code;
}
