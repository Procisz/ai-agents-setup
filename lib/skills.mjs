import fs from "node:fs";
import path from "node:path";

export const ROLES = Object.freeze(["orchestrator", "planner", "docs", "coder", "tester", "reviewer", "debugger", "git"]);
export const SKILL_FILE = "SKILL.md";
export const SKILLS_DIR = "skills";
export const DESCRIPTION_MAX = 300;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ROLE_KEYS = Object.freeze({ required: "wf-required", defaults: "wf-default" });

const KEY_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR = /^([|>])([+-]?)$/;

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeText(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input);
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function indentOf(line) {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  return count;
}

function isSkippable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function stripComment(text) {
  const match = /(^|[ \t])#/.exec(text);
  return (match ? text.slice(0, match.index) : text).trim();
}

function plainScalar(text) {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~" || text === "") return null;
  return text;
}

function readQuoted(text) {
  const quote = text[0];
  let value = "";
  let i = 1;
  while (i < text.length) {
    const c = text[i];
    if (quote === "'" && c === "'") {
      if (text[i + 1] === "'") {
        value += "'";
        i += 2;
        continue;
      }
      return { value, rest: text.slice(i + 1) };
    }
    if (quote === '"' && c === "\\") {
      const next = text[i + 1];
      const escapes = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0", b: "\b", f: "\f" };
      if (next === "u" && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 2, i + 6))) {
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      if (next !== undefined && Object.hasOwn(escapes, next)) {
        value += escapes[next];
        i += 2;
        continue;
      }
      return null;
    }
    if (quote === '"' && c === '"') return { value, rest: text.slice(i + 1) };
    value += c;
    i += 1;
  }
  return null;
}

function parseScalar(text, where, errors) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quoted = readQuoted(text);
    if (quoted === null) {
      errors.push(`${where}: unterminated or invalid quoted string`);
      return null;
    }
    if (stripComment(quoted.rest) !== "") errors.push(`${where}: unexpected text after the closing quote`);
    return quoted.value;
  }
  return plainScalar(stripComment(text));
}

function splitFlowItems(inner) {
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (quote) return null;
  if (current.trim() !== "" || items.length > 0) items.push(current.trim());
  return items;
}

function parseFlowList(text, where, errors) {
  const close = text.lastIndexOf("]");
  if (close < 0 || stripComment(text.slice(close + 1)) !== "") {
    errors.push(`${where}: a flow list must end with ]`);
    return [];
  }
  const inner = text.slice(1, close);
  if (/[[\]{}]/.test(inner.replace(/"[^"]*"|'[^']*'/g, ""))) {
    errors.push(`${where}: nested flow collections are not supported`);
    return [];
  }
  const items = splitFlowItems(inner);
  if (items === null) {
    errors.push(`${where}: unterminated quoted string in a flow list`);
    return [];
  }
  if (items.length > 0 && items[items.length - 1] === "" && items.length > 1) items.pop();
  if (items.some((item) => item === "")) {
    errors.push(`${where}: empty item in a flow list`);
    return [];
  }
  return items.map((item) => parseScalar(item, where, errors));
}

export function parseYamlSubset(text) {
  const lines = normalizeText(text).split("\n");
  const errors = [];
  let index = 0;

  const nextContent = () => {
    let i = index;
    while (i < lines.length && isSkippable(lines[i])) i += 1;
    return i;
  };

  const lineLabel = (i) => `line ${i + 1}`;

  const parseBlockScalar = (indicator, parentIndent) => {
    const [, style, chomp] = BLOCK_SCALAR.exec(indicator);
    const collected = [];
    let blockIndent = null;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === "") {
        collected.push("");
        index += 1;
        continue;
      }
      const indent = indentOf(line);
      if (indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = indent;
      if (indent < blockIndent) break;
      collected.push(line.slice(blockIndent));
      index += 1;
    }
    let trailing = 0;
    while (collected.length > 0 && collected[collected.length - 1] === "") {
      collected.pop();
      trailing += 1;
    }
    let value;
    if (style === "|") {
      value = collected.join("\n");
    } else {
      value = "";
      for (const line of collected) {
        if (line === "") value += "\n";
        else if (value === "" || value.endsWith("\n")) value += line;
        else value += ` ${line}`;
      }
    }
    if (value === "") return "";
    if (chomp === "-") return value;
    if (chomp === "+") return value + "\n".repeat(trailing + 1);
    return `${value}\n`;
  };

  let parseMap;

  const parseBlockList = (listIndent) => {
    const out = [];
    while (true) {
      const at = nextContent();
      if (at >= lines.length) {
        index = at;
        break;
      }
      const line = lines[at];
      const indent = indentOf(line);
      const content = line.slice(indent);
      if (indent !== listIndent || !(content === "-" || content.startsWith("- "))) break;
      index = at + 1;
      const item = content === "-" ? "" : content.slice(2).trim();
      if (item === "") {
        errors.push(`${lineLabel(at)}: empty list item`);
        continue;
      }
      if (item.startsWith("[") || item.startsWith("{") || KEY_PATTERN.test(item)) {
        errors.push(`${lineLabel(at)}: list items must be plain or quoted scalars`);
        continue;
      }
      out.push(parseScalar(item, lineLabel(at), errors));
    }
    return out;
  };

  const parseValue = (rest, at, indent) => {
    const value = rest === undefined ? "" : rest.trim();
    if (value.startsWith("[")) return parseFlowList(value, lineLabel(at), errors);
    if (value.startsWith("{")) {
      errors.push(`${lineLabel(at)}: flow maps are not supported; use an indented block`);
      return null;
    }
    if (BLOCK_SCALAR.test(stripComment(value)) && !value.startsWith('"') && !value.startsWith("'")) {
      return parseBlockScalar(stripComment(value), indent);
    }
    if (stripComment(value) !== "" || value.startsWith('"') || value.startsWith("'")) {
      return parseScalar(value, lineLabel(at), errors);
    }
    const next = nextContent();
    if (next >= lines.length) return null;
    const nextIndent = indentOf(lines[next]);
    const nextContentText = lines[next].slice(nextIndent);
    const isItem = nextContentText === "-" || nextContentText.startsWith("- ");
    if (isItem && nextIndent >= indent) return parseBlockList(nextIndent);
    if (nextIndent > indent) return parseMap(nextIndent);
    return null;
  };

  parseMap = (mapIndent) => {
    const out = {};
    while (true) {
      const at = nextContent();
      if (at >= lines.length) {
        index = at;
        break;
      }
      const line = lines[at];
      if (/^[ \t]*\t/.test(line)) {
        errors.push(`${lineLabel(at)}: tabs are not allowed for indentation`);
        index = at + 1;
        continue;
      }
      const indent = indentOf(line);
      if (indent < mapIndent) {
        index = at;
        break;
      }
      if (indent > mapIndent) {
        errors.push(`${lineLabel(at)}: unexpected indentation`);
        index = at + 1;
        continue;
      }
      const content = line.slice(indent);
      const match = KEY_PATTERN.exec(content);
      if (!match) {
        errors.push(`${lineLabel(at)}: expected "key: value"`);
        index = at + 1;
        continue;
      }
      const key = match[1];
      index = at + 1;
      const value = parseValue(match[2], at, indent);
      if (Object.hasOwn(out, key)) errors.push(`${lineLabel(at)}: duplicate key ${key}`);
      else out[key] = value;
    }
    return out;
  };

  const data = parseMap(0);
  return { data, errors };
}

export function parseFrontmatter(text) {
  const source = normalizeText(text);
  const lines = source.split("\n");
  if (lines[0].trimEnd() !== "---") {
    return { data: {}, body: source, errors: ["missing opening --- line"], hasFrontmatter: false };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return { data: {}, body: source, errors: ["missing closing --- line"], hasFrontmatter: false };
  }
  const parsed = parseYamlSubset(lines.slice(1, close).join("\n"));
  const errors = parsed.errors.map((error) => error.replace(/^line (\d+)/, (whole, n) => `line ${Number(n) + 1}`));
  return { data: parsed.data, body: lines.slice(close + 1).join("\n"), errors, hasFrontmatter: true };
}

export function listSkillFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort(compareText);
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string"))];
}

function trimBody(body) {
  return body.replace(/^\s*\n/, "").trimEnd();
}

export function loadSkill(dir, label = `${SKILLS_DIR}/${path.basename(dir)}`) {
  const name = path.basename(dir);
  const files = listSkillFiles(dir);
  const contents = {};
  const binary = [];
  for (const rel of files) {
    const buffer = fs.readFileSync(path.join(dir, ...rel.split("/")));
    if (buffer.includes(0)) {
      binary.push(rel);
      continue;
    }
    contents[rel] = normalizeText(buffer);
  }
  const parsed = parseFrontmatter(contents[SKILL_FILE] ?? "");
  const frontmatter = isPlainObject(parsed.data) ? parsed.data : {};
  const metadata = isPlainObject(frontmatter.metadata) ? frontmatter.metadata : {};
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  return {
    name,
    description,
    required: stringList(metadata[ROLE_KEYS.required]),
    defaults: stringList(metadata[ROLE_KEYS.defaults]),
    dir,
    body: trimBody(parsed.body),
    files,
    frontmatter,
    contents,
    binary,
    label,
    errors: parsed.errors
  };
}

export function loadSkills(skillsRoot, labelRoot = SKILLS_DIR) {
  const skills = [];
  const problems = [];
  let entries;
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { skills, problems };
    throw error;
  }
  entries.sort((a, b) => compareText(a.name, b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const label = `${labelRoot}/${entry.name}`;
    if (!entry.isDirectory()) {
      problems.push({ level: "warning", where: label, message: "is not a skill folder and is ignored; skills live in skills/<name>/SKILL.md" });
      continue;
    }
    const dir = path.join(skillsRoot, entry.name);
    if (!fs.existsSync(path.join(dir, SKILL_FILE))) {
      problems.push({ level: "error", where: label, message: `has no ${SKILL_FILE}; add one or remove the folder` });
      continue;
    }
    skills.push(loadSkill(dir, label));
  }
  return { skills, problems };
}

function roleListFindings(value, key, where, roles) {
  const out = [];
  if (value === undefined) return out;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    out.push({ level: "error", where, message: `metadata.${key} must be a list of role names such as [coder, tester]` });
    return out;
  }
  for (const role of value) {
    if (!roles.includes(role)) out.push({ level: "error", where, message: `metadata.${key} names unknown role ${role}; use ${roles.join(", ")}` });
  }
  return out;
}

export function validateSkill(skill, roles = ROLES) {
  const where = `${skill.label ?? `${SKILLS_DIR}/${skill.name}`}/${SKILL_FILE}`;
  const out = [];
  const error = (message) => out.push({ level: "error", where, message });
  const warning = (message) => out.push({ level: "warning", where, message });
  for (const problem of skill.errors ?? []) error(`frontmatter ${problem}`);
  const fm = isPlainObject(skill.frontmatter) ? skill.frontmatter : {};
  if (!SKILL_NAME_PATTERN.test(skill.name)) error(`folder name ${skill.name} must be lowercase words joined by hyphens`);
  if (fm.name === undefined || fm.name === null) error(`frontmatter name is missing; add name: ${skill.name}`);
  else if (fm.name !== skill.name) error(`frontmatter name ${JSON.stringify(fm.name)} differs from the folder name ${skill.name}`);
  if (typeof fm.description !== "string" || fm.description.trim() === "") {
    error("frontmatter description is missing; add one line of at most 300 characters");
  } else {
    const description = fm.description.trim();
    if (description.includes("\n")) error("description must be one line");
    if (description.length > DESCRIPTION_MAX) error(`description has ${description.length} characters, over the limit of ${DESCRIPTION_MAX}`);
  }
  if (fm.metadata !== undefined && fm.metadata !== null && !isPlainObject(fm.metadata)) {
    error("metadata must be an indented map");
  }
  const metadata = isPlainObject(fm.metadata) ? fm.metadata : {};
  for (const key of Object.keys(metadata)) {
    if (key.startsWith("wf-") && key !== ROLE_KEYS.required && key !== ROLE_KEYS.defaults) {
      error(`unknown metadata key ${key}; use ${ROLE_KEYS.required} or ${ROLE_KEYS.defaults}`);
    }
  }
  out.push(...roleListFindings(metadata[ROLE_KEYS.required], ROLE_KEYS.required, where, roles));
  out.push(...roleListFindings(metadata[ROLE_KEYS.defaults], ROLE_KEYS.defaults, where, roles));
  const both = stringList(metadata[ROLE_KEYS.required]).filter((role) => stringList(metadata[ROLE_KEYS.defaults]).includes(role));
  for (const role of both) warning(`role ${role} is in both ${ROLE_KEYS.required} and ${ROLE_KEYS.defaults}; keep it in ${ROLE_KEYS.required} only`);
  if ((skill.body ?? "").trim() === "") warning("the skill body is empty");
  for (const rel of skill.binary ?? []) {
    out.push({ level: "error", where: `${skill.label ?? `${SKILLS_DIR}/${skill.name}`}/${rel}`, message: "is not a text file; skills hold UTF-8 text only" });
  }
  return out;
}
