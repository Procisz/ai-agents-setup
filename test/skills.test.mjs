import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTION_MAX,
  ROLES,
  listSkillFiles,
  loadSkill,
  loadSkills,
  normalizeText,
  parseFrontmatter,
  parseYamlSubset,
  validateSkill
} from "../lib/skills.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSkills = path.join(here, "data", "compile", "skills");
const tempRoots = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-skills-"));
  tempRoots.push(dir);
  return dir;
}

function writeSkill(root, name, text, extra = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), text);
  for (const [rel, content] of Object.entries(extra)) {
    const file = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function skillText({ name = "sample", description = "A sample skill.", metadata = "metadata:\n  wf-required: [coder]\n  wf-default: [tester]\n", body = "# Sample\n\nBody.\n" } = {}) {
  return `---\nname: ${name}\ndescription: ${description}\n${metadata}---\n\n${body}`;
}

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseYamlSubset", () => {
  test("reads plain, quoted and keyword scalars", () => {
    const { data, errors } = parseYamlSubset(
      [
        "name: testing",
        "quoted: \"a: b, c\"",
        "single: 'it''s'",
        "flag: true",
        "off: false",
        "empty:",
        "tilde: ~",
        "url: https://example.com/a#b",
        "note: value # trailing comment",
        "escaped: \"line\\nnext \\u0041\""
      ].join("\n")
    );
    assert.deepEqual(errors, []);
    assert.equal(data.name, "testing");
    assert.equal(data.quoted, "a: b, c");
    assert.equal(data.single, "it's");
    assert.equal(data.flag, true);
    assert.equal(data.off, false);
    assert.equal(data.empty, null);
    assert.equal(data.tilde, null);
    assert.equal(data.url, "https://example.com/a#b");
    assert.equal(data.note, "value");
    assert.equal(data.escaped, "line\nnext A");
  });

  test("reads flow lists, including empty and quoted items", () => {
    const { data, errors } = parseYamlSubset("a: [tester]\nb: []\nc: [coder, \"x, y\", 'z']\nd: [one, two,]");
    assert.deepEqual(errors, []);
    assert.deepEqual(data.a, ["tester"]);
    assert.deepEqual(data.b, []);
    assert.deepEqual(data.c, ["coder", "x, y", "z"]);
    assert.deepEqual(data.d, ["one", "two"]);
  });

  test("reads block lists indented or at the key's level", () => {
    const { data, errors } = parseYamlSubset("a:\n  - one\n  - \"two\"\nb:\n- three\nc: done");
    assert.deepEqual(errors, []);
    assert.deepEqual(data.a, ["one", "two"]);
    assert.deepEqual(data.b, ["three"]);
    assert.equal(data.c, "done");
  });

  test("reads a nested map with flow and block lists", () => {
    const { data, errors } = parseYamlSubset("metadata:\n  wf-required: [tester]\n  wf-default:\n    - coder\n    - docs\n  author: me\nafter: x");
    assert.deepEqual(errors, []);
    assert.deepEqual(data.metadata, { "wf-required": ["tester"], "wf-default": ["coder", "docs"], author: "me" });
    assert.equal(data.after, "x");
  });

  test("reads folded and literal block scalars with chomping", () => {
    const { data, errors } = parseYamlSubset("f: >\n  one\n  two\n\n  three\nl: |-\n  a\n  b\nk: |\n  keep\nnext: 1");
    assert.deepEqual(errors, []);
    assert.equal(data.f, "one two\nthree\n");
    assert.equal(data.l, "a\nb");
    assert.equal(data.k, "keep\n");
    assert.equal(data.next, "1");
  });

  test("skips comments and blank lines", () => {
    const { data, errors } = parseYamlSubset("# heading\n\nname: x\n  # indented comment\nother: y");
    assert.deepEqual(errors, []);
    assert.deepEqual(data, { name: "x", other: "y" });
  });

  test("reports malformed input with line numbers", () => {
    const cases = [
      ["just text", /line 1: expected "key: value"/],
      ["a: x\n    b: y", /line 2: unexpected indentation/],
      ["a: [x, [y]]", /nested flow collections/],
      ["a: [x, y", /must end with \]/],
      ["a: {x: 1}", /flow maps are not supported/],
      ["a: \"open", /unterminated/],
      ["a: x\na: y", /line 2: duplicate key a/],
      ["a:\n\t- x", /tabs are not allowed/],
      ["a:\n  - key: value", /plain or quoted scalars/],
      ["a: [x,,y]", /empty item/],
      ["a: \"x\" tail", /unexpected text after the closing quote/]
    ];
    for (const [text, pattern] of cases) {
      const { errors } = parseYamlSubset(text);
      assert.ok(errors.some((error) => pattern.test(error)), `${JSON.stringify(text)} should report ${pattern}, got ${JSON.stringify(errors)}`);
    }
  });
});

describe("parseFrontmatter", () => {
  test("splits frontmatter and body and shifts error lines to the file", () => {
    const parsed = parseFrontmatter("---\nname: x\nbad line\n---\n\nBody\n");
    assert.equal(parsed.hasFrontmatter, true);
    assert.equal(parsed.data.name, "x");
    assert.equal(parsed.body, "\nBody\n");
    assert.deepEqual(parsed.errors, ['line 3: expected "key: value"']);
  });

  test("normalizes CRLF and a byte order mark", () => {
    const parsed = parseFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nBody\r\n");
    assert.equal(parsed.data.name, "x");
    assert.equal(parsed.body, "Body\n");
  });

  test("reports a missing opening or closing line", () => {
    assert.deepEqual(parseFrontmatter("name: x\n").errors, ["missing opening --- line"]);
    assert.deepEqual(parseFrontmatter("---\nname: x\n").errors, ["missing closing --- line"]);
  });

  test("normalizeText converts lone carriage returns too", () => {
    assert.equal(normalizeText("a\rb\r\nc"), "a\nb\nc");
  });
});

describe("loading skills", () => {
  test("loads the fixture skills in folder order with roles, files and bodies", () => {
    const { skills, problems } = loadSkills(fixtureSkills);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["alpha", "beta", "gamma"]
    );
    const [alpha, beta, gamma] = skills;
    assert.deepEqual(alpha.required, ["orchestrator"]);
    assert.deepEqual(alpha.defaults, []);
    assert.deepEqual(beta.files, ["SKILL.md", "references/guide.md"]);
    assert.deepEqual(beta.defaults, ["coder", "tester", "reviewer"]);
    assert.equal(beta.description, "Beta engineering skill: shared conventions for code.");
    assert.equal(gamma.description, "Gamma testing skill, folded over two lines.");
    assert.deepEqual(gamma.required, ["tester"]);
    assert.deepEqual(gamma.defaults, ["coder"]);
    assert.equal(gamma.frontmatter.license, "MIT");
    assert.ok(alpha.body.startsWith("# Alpha"), "the body starts after the frontmatter and its blank line");
    assert.ok(!alpha.body.includes("wf-required"), "the body holds no frontmatter");
    assert.equal(alpha.dir, path.join(fixtureSkills, "alpha"));
    assert.equal(alpha.label, "skills/alpha");
  });

  test("lists nested files sorted and skips dot files", () => {
    const root = tempDir();
    const dir = writeSkill(root, "files", skillText({ name: "files" }), {
      "references/b.md": "b\n",
      "references/a.md": "a\n",
      ".DS_Store": "x",
      ".hidden/c.md": "c\n",
      "LICENSE": "MIT\n"
    });
    assert.deepEqual(listSkillFiles(dir), ["LICENSE", "SKILL.md", "references/a.md", "references/b.md"]);
  });

  test("keeps file contents normalized and marks binary files", () => {
    const root = tempDir();
    const dir = writeSkill(root, "bin", skillText({ name: "bin" }), { "notes.md": "a\r\nb\r\n", "image.png": Buffer.from([0x89, 0x50, 0x00, 0x01]) });
    const skill = loadSkill(dir);
    assert.equal(skill.contents["notes.md"], "a\nb\n");
    assert.deepEqual(skill.binary, ["image.png"]);
    assert.equal(skill.contents["image.png"], undefined);
  });

  test("reports folders without SKILL.md and stray files, and tolerates a missing root", () => {
    const root = tempDir();
    writeSkill(root, "good", skillText({ name: "good" }));
    fs.mkdirSync(path.join(root, "empty"));
    fs.writeFileSync(path.join(root, "README.md"), "x\n");
    const { skills, problems } = loadSkills(root);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["good"]
    );
    assert.deepEqual(
      problems.map((problem) => [problem.level, problem.where]),
      [
        ["warning", "skills/README.md"],
        ["error", "skills/empty"]
      ]
    );
    assert.deepEqual(loadSkills(path.join(root, "missing")), { skills: [], problems: [] });
  });
});

describe("validateSkill", () => {
  function validate(text, name = "sample", extra = {}) {
    const root = tempDir();
    return validateSkill(loadSkill(writeSkill(root, name, text, extra)));
  }

  function messages(findings, level = "error") {
    return findings.filter((item) => item.level === level).map((item) => item.message);
  }

  test("accepts the fixture skills", () => {
    for (const skill of loadSkills(fixtureSkills).skills) assert.deepEqual(validateSkill(skill), [], skill.name);
  });

  test("requires the name to equal the folder", () => {
    assert.match(messages(validate(skillText({ name: "other" })))[0], /differs from the folder name sample/);
    assert.match(messages(validate("---\ndescription: x\n---\nBody\n"))[0], /name is missing/);
  });

  test("requires a kebab-case folder name", () => {
    assert.ok(messages(validate(skillText({ name: "Bad_Name" }), "Bad_Name")).some((message) => /lowercase words joined by hyphens/.test(message)));
  });

  test("requires a one-line description of at most 300 characters", () => {
    assert.match(messages(validate(skillText({ description: "" })))[0], /description is missing/);
    const long = "x".repeat(DESCRIPTION_MAX + 1);
    assert.match(messages(validate(skillText({ description: long })))[0], /301 characters, over the limit of 300/);
    assert.deepEqual(messages(validate(skillText({ description: "x".repeat(DESCRIPTION_MAX) }))), []);
    assert.match(messages(validate(skillText({ description: "|\n  one\n  two" })))[0], /must be one line/);
  });

  test("requires wf-required and wf-default to name real roles", () => {
    const findings = validate(skillText({ metadata: "metadata:\n  wf-required: [coder, writer]\n  wf-default: tester\n" }));
    const errors = messages(findings);
    assert.ok(errors.some((message) => /wf-required names unknown role writer/.test(message)), JSON.stringify(errors));
    assert.ok(errors.some((message) => /wf-default must be a list of role names/.test(message)), JSON.stringify(errors));
  });

  test("refuses unknown wf metadata keys and a non-map metadata", () => {
    assert.match(messages(validate(skillText({ metadata: "metadata:\n  wf-defaults: [coder]\n" })))[0], /unknown metadata key wf-defaults/);
    assert.match(messages(validate(skillText({ metadata: "metadata: [coder]\n" })))[0], /metadata must be an indented map/);
  });

  test("accepts a skill with no metadata at all, as a library-only skill", () => {
    assert.deepEqual(validate(skillText({ metadata: "" })), []);
  });

  test("warns about a role in both lists and an empty body", () => {
    const warnings = messages(validate(skillText({ metadata: "metadata:\n  wf-required: [coder]\n  wf-default: [coder]\n", body: "\n" })), "warning");
    assert.ok(warnings.some((message) => /role coder is in both/.test(message)), JSON.stringify(warnings));
    assert.ok(warnings.some((message) => /body is empty/.test(message)), JSON.stringify(warnings));
  });

  test("reports frontmatter syntax errors and binary files", () => {
    const findings = validate(skillText({ metadata: "metadata:\n  wf-required: [coder\n" }), "sample", { "a.bin": Buffer.from([0, 1, 2]) });
    const errors = findings.filter((item) => item.level === "error");
    assert.ok(errors.some((item) => /frontmatter line 5: a flow list must end/.test(item.message)), JSON.stringify(errors));
    assert.ok(errors.some((item) => item.where === "skills/sample/a.bin" && /not a text file/.test(item.message)), JSON.stringify(errors));
  });

  test("knows the eight wf roles, the debugger before the git agent (D110, D115)", () => {
    assert.deepEqual([...ROLES], ["orchestrator", "planner", "docs", "coder", "tester", "reviewer", "debugger", "git"]);
  });

  test("accepts git in wf-required and wf-default", () => {
    const findings = validate(skillText({ metadata: "metadata:\n  wf-required: [git]\n  wf-default: [git]\n" }), "sample");
    assert.deepEqual(findings.filter((item) => item.level === "error"), []);
  });

  test("accepts the debugger in wf-required and wf-default", () => {
    const findings = validate(skillText({ metadata: "metadata:\n  wf-required: [debugger]\n  wf-default: [coder]\n" }), "sample");
    assert.deepEqual(findings.filter((item) => item.level === "error"), []);
  });
});
