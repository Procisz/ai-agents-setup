import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BOX, PLAIN_UI, SYMBOLS, breakToken, colorEnabled, createUi, detectUi, richEnabled, stripAnsi, unicodeEnabled, visibleLength, wrapText } from "../lib/ui.mjs";

const TTY = { isTTY: true, columns: 90 };
const PIPE = { isTTY: false };
const FORBIDDEN = /[\u2012-\u2015]/;

describe("terminal detection", () => {
  const colors = [
    ["a terminal", TTY, {}, true],
    ["a pipe", PIPE, {}, false],
    ["NO_COLOR in a terminal", TTY, { NO_COLOR: "1" }, false],
    ["an empty NO_COLOR", TTY, { NO_COLOR: "" }, true],
    ["FORCE_COLOR on a pipe", PIPE, { FORCE_COLOR: "1" }, true],
    ["an empty FORCE_COLOR on a pipe", PIPE, { FORCE_COLOR: "" }, true],
    ["FORCE_COLOR over NO_COLOR", PIPE, { FORCE_COLOR: "1", NO_COLOR: "1" }, true],
    ["FORCE_COLOR=0 in a terminal", TTY, { FORCE_COLOR: "0" }, false],
    ["FORCE_COLOR=false in a terminal", TTY, { FORCE_COLOR: "false" }, false],
    ["a dumb terminal", TTY, { TERM: "dumb" }, false]
  ];
  for (const [name, stream, env, want] of colors) {
    test(`colors: ${name} -> ${want}`, () => assert.equal(colorEnabled({ stream, env }), want));
  }

  const unicode = [
    ["macOS", "darwin", {}, true],
    ["Linux", "linux", { TERM: "xterm-256color" }, true],
    ["a dumb terminal", "linux", { TERM: "dumb" }, false],
    ["Windows Terminal", "win32", { WT_SESSION: "abc" }, true],
    ["the old Windows console", "win32", {}, false],
    ["the old Windows console with an empty WT_SESSION", "win32", { WT_SESSION: "" }, false]
  ];
  for (const [name, platform, env, want] of unicode) {
    test(`unicode: ${name} -> ${want}`, () => assert.equal(unicodeEnabled({ env, platform }), want));
  }

  test("rich layout needs a terminal; FORCE_COLOR forces colors only", () => {
    assert.equal(richEnabled({ stream: TTY, env: {} }), true);
    assert.equal(richEnabled({ stream: TTY, env: { NO_COLOR: "1" } }), true, "NO_COLOR drops colors, not the layout");
    assert.equal(richEnabled({ stream: PIPE, env: {} }), false);
    assert.equal(richEnabled({ stream: PIPE, env: { FORCE_COLOR: "1" } }), false, "FORCE_COLOR on a pipe keeps the plain layout");
    assert.equal(richEnabled({ stream: PIPE, env: { FORCE_COLOR: "0" } }), false);
  });

  test("detectUi on a pipe with FORCE_COLOR has colors but no box, icons or wrapping", () => {
    const ui = detectUi({ stream: PIPE, env: { FORCE_COLOR: "1" }, platform: "darwin" });
    assert.deepEqual([ui.rich, ui.unicode, ui.color], [false, false, true]);
    assert.deepEqual(ui.done("Tiers", "T1"), ["Tiers: T1"]);
    assert.deepEqual(ui.status("ok", "Lint: 0 errors"), ["Lint: 0 errors"]);
    assert.deepEqual(ui.header({ name: "wf", version: "2.0.0", about: "a" }), []);
    assert.deepEqual(ui.text(`see /${"a".repeat(200)}`), [`see /${"a".repeat(200)}`], "a long path stays whole");
  });

  test("detectUi on a pipe is plain ASCII without colors, whatever the platform", () => {
    const ui = detectUi({ stream: PIPE, env: {}, platform: "darwin" });
    assert.deepEqual([ui.rich, ui.color, ui.unicode], [false, false, false]);
    assert.equal(ui.sym("ok"), "+");
  });

  test("detectUi on a terminal follows NO_COLOR, TERM and Windows Terminal", () => {
    const mac = detectUi({ stream: TTY, env: {}, platform: "darwin" });
    assert.deepEqual([mac.rich, mac.color, mac.unicode, mac.width()], [true, true, true, 90]);
    const plainColors = detectUi({ stream: TTY, env: { NO_COLOR: "1" }, platform: "darwin" });
    assert.deepEqual([plainColors.color, plainColors.unicode], [false, true]);
    const dumb = detectUi({ stream: TTY, env: { TERM: "dumb" }, platform: "linux" });
    assert.deepEqual([dumb.rich, dumb.color, dumb.unicode], [true, false, false]);
    const conhost = detectUi({ stream: TTY, env: {}, platform: "win32" });
    assert.deepEqual([conhost.color, conhost.unicode], [true, false]);
    assert.equal(detectUi({ stream: TTY, env: { WT_SESSION: "1" }, platform: "win32" }).unicode, true);
  });
});

describe("symbols", () => {
  test("every symbol has a Unicode and an ASCII form, with no em or en dash", () => {
    for (const [name, [unicode, ascii]] of Object.entries(SYMBOLS)) {
      assert.ok(/^[\x20-\x7e]*$/.test(ascii), `${name} ASCII form is ASCII`);
      assert.ok(!FORBIDDEN.test(unicode), `${name} has no em or en dash`);
      assert.ok([...unicode].length <= 1 || unicode === ascii, `${name} is single width`);
    }
    for (const set of Object.values(BOX)) for (const char of Object.values(set)) assert.ok(!FORBIDDEN.test(char));
  });
});

describe("plain output", () => {
  test("adds no codes, icons or layout", () => {
    assert.equal(PLAIN_UI.paint("bold cyan", "x"), "x");
    assert.deepEqual(PLAIN_UI.status("ok", "Lint: 0 errors"), ["Lint: 0 errors"]);
    assert.deepEqual(PLAIN_UI.status("warn", "text", { plain: "warning: text" }), ["warning: text"]);
    assert.deepEqual(PLAIN_UI.header({ name: "wf", version: "2.0.0", about: "a" }), []);
    assert.deepEqual(PLAIN_UI.blank(), []);
    assert.deepEqual(PLAIN_UI.step({ number: 2, total: 5, emoji: "x", title: "Agents" }), ["Step 2 of 5: Agents"]);
    assert.deepEqual(PLAIN_UI.explain(["one", "two"]), ["  one", "  two"]);
    assert.deepEqual(PLAIN_UI.done("Tiers", "T1"), ["Tiers: T1"]);
    assert.deepEqual(PLAIN_UI.row("Config", "/c"), ["Config /c"]);
    assert.deepEqual(PLAIN_UI.para("text", { first: "  " }), ["  text"]);
  });
});

describe("rich output", () => {
  const ui = createUi({ rich: true, unicode: true, color: true, columns: 60 });
  const ascii = createUi({ rich: true, unicode: false, color: false, columns: 60 });

  test("paint wraps text in the codes and closes them", () => {
    assert.equal(ui.paint("bold cyan", "x"), "\u001b[1m\u001b[36mx\u001b[39m\u001b[22m");
    assert.equal(ui.paint("unknown", "x"), "x");
    assert.equal(ui.paint("green", ""), "");
  });

  test("status lines get a colored icon and a hanging indent", () => {
    const lines = ui.status("warn", "word ".repeat(30).trim());
    assert.ok(lines.length > 1);
    assert.ok(lines[0].startsWith("  \u001b[33m\u26a0\u001b[39m "));
    assert.ok(lines.slice(1).every((line) => line.startsWith("    ")));
    assert.ok(lines.every((line) => visibleLength(line) <= 59), "the color codes do not count toward the width");
    assert.deepEqual(ascii.status("ok", "done"), ["  + done"]);
    assert.deepEqual(ascii.status("fail", "bad"), ["  x bad"]);
    assert.deepEqual(ui.status("info", `a ${"b".repeat(80)} c`, { wrap: false }).length, 1, "a command stays on one line to copy");
  });

  test("the header box has the name, version and what install does, in Unicode or ASCII", () => {
    const lines = ui.header({ name: "wf", version: "2.0.0", about: "Sets up wf." }).map(stripAnsi);
    assert.equal(lines[0], "");
    assert.ok(lines[1].startsWith("  \u256d\u2500"));
    assert.ok(lines.some((line) => line.includes("wf 2.0.0 \u00b7 installer")));
    assert.ok(lines.some((line) => line.includes("Sets up wf.")));
    const widths = new Set(lines.filter((line) => line !== "").map((line) => [...line].length));
    assert.equal(widths.size, 1, "every box line has the same width");
    const plainBox = ascii.header({ name: "wf", version: "2.0.0", about: "Sets up wf." });
    assert.ok(plainBox[1].startsWith("  +-"));
    assert.ok(plainBox.some((line) => line.includes("wf 2.0.0 - installer")));
    assert.ok(plainBox.every((line) => /^[\x20-\x7e]*$/.test(line)));
  });

  test("a step line leads with its emoji only in a Unicode terminal", () => {
    assert.deepEqual(ui.step({ number: 1, total: 5, emoji: "\u{1F4CA}", title: "Tiers" }).map(stripAnsi), ["", "  Step 1 of 5  \u{1F4CA} Tiers"]);
    assert.deepEqual(ascii.step({ number: 1, total: 5, emoji: "\u{1F4CA}", title: "Tiers" }), ["", "  Step 1 of 5  >> Tiers"]);
  });

  test("done lines fit the width and wrap a long answer with a hanging indent instead of cutting it", () => {
    assert.deepEqual(ui.done("Tiers", "T1, T2").map(stripAnsi), ["  \u2714 Tiers: T1, T2"]);
    assert.ok(ui.done("Tiers", "T1")[0].includes("\u001b[1mTiers\u001b[22m"), "the title is bold");
    const long = ui.done("Models", "Sonnet 5.5 (Opus 5.5 agents run on Sonnet 5.5, Haiku 5.5 agents run on Sonnet 5.5)").map(stripAnsi);
    assert.ok(long.length > 1, JSON.stringify(long));
    assert.ok(long.every((line) => visibleLength(line) <= 59), JSON.stringify(long));
    assert.ok(long.slice(1).every((line) => line.startsWith("    ") && line[4] !== " "), "the rest hangs under the title");
    assert.ok(!long.some((line) => line.endsWith("\u2026")), "nothing is cut");
    assert.ok(long[0].startsWith("  \u2714 Models: "));
    assert.equal(long.map((line) => line.slice(4)).join(" "), "Models: Sonnet 5.5 (Opus 5.5 agents run on Sonnet 5.5, Haiku 5.5 agents run on Sonnet 5.5)");
    const token = ui.done("coder", "x".repeat(100)).map(stripAnsi);
    assert.ok(token.every((line) => visibleLength(line) <= 59) && token.join("").includes("x".repeat(40)));
  });

  test("explain keeps one sentence per line when they fit, else wraps them as one paragraph", () => {
    const sentences = ["Check the setup below. Nothing is written until you choose Install,", "and every file it changes is backed up first."];
    const wide = createUi({ rich: true, unicode: true, color: false, columns: 80 });
    assert.deepEqual(wide.explain(sentences), sentences.map((line) => `  ${line}`));
    const narrow = ascii.explain(sentences);
    assert.ok(narrow.every((line) => visibleLength(line) <= 59), JSON.stringify(narrow));
    assert.ok(!narrow.some((line) => line.trim() === "choose Install,"), "no stray half sentence on its own line");
    assert.equal(narrow.map((line) => line.trim()).join(" "), sentences.join(" "));
  });

  test("row keeps a label column and breaks a long path after a separator, never past the width", () => {
    const short = ascii.row("Config", "/Users/you/.claude", { pad: 8 });
    assert.deepEqual(short, ["  Config    /Users/you/.claude"]);
    const path = `/private/tmp/${"a".repeat(30)}/${"b".repeat(30)}/config`;
    const lines = ascii.row("Launcher", path, { pad: 8 });
    assert.ok(lines.length > 1);
    assert.ok(lines.every((line) => visibleLength(line) <= 59), JSON.stringify(lines));
    assert.ok(lines.slice(1).every((line) => line.startsWith(" ".repeat(12))), "the path continues under itself");
    assert.ok(lines[0].endsWith("/"), "it breaks after a path separator");
    assert.equal(lines.map((line, index) => (index === 0 ? line.slice(12) : line.trim())).join(""), path);
  });

  test("a non-breaking space keeps a pair together and prints as a plain space", () => {
    const pairs = ["orchestrator 5", "planner 3", "docs 2", "coder 3", "tester 4", "reviewer 7"].map((pair) => pair.replace(" ", "\u00a0"));
    const lines = ui.status("info", `Skills: ${pairs.join("\u00a0\u00b7 ")}`).map(stripAnsi);
    assert.ok(lines.every((line) => visibleLength(line) <= 59), JSON.stringify(lines));
    assert.ok(!lines.some((line) => line.includes("\u00a0")));
    for (const pair of ["orchestrator 5", "planner 3", "reviewer 7"]) assert.ok(lines.some((line) => line.includes(pair)), `${pair} stays on one line`);
    assert.ok(!lines.some((line) => line.trim().startsWith("\u00b7")), "no line starts with the separator");
  });

  test("tables pad every column but the last and dim the header", () => {
    const lines = ascii.table([["orchestrator", "main", "Opus"], ["coder", "T1", "Haiku"]], { header: ["Role", "Tier", "Model"] });
    assert.deepEqual(lines, ["  Role          Tier  Model", "  orchestrator  main  Opus", "  coder         T1    Haiku"]);
    const colored = ui.table([[{ text: "a", style: "yellow" }, "b"]]);
    assert.equal(stripAnsi(colored[0]), "  a  b");
    assert.ok(colored[0].includes("\u001b[33m"));
  });
});

describe("wrapText", () => {
  test("wraps at spaces and never splits a word, so paths stay whole", () => {
    assert.deepEqual(wrapText("one two three four five", 12), ["one two", "three four", "five"]);
    const path = `/a/${"b".repeat(40)}/c`;
    assert.deepEqual(wrapText(`see ${path} now`, 20), ["see", path, "now"]);
    assert.deepEqual(wrapText("", 20), [""]);
  });

  test("with split, a word longer than the width breaks after a path separator, else at the width", () => {
    const path = `/a/${"b".repeat(14)}/${"c".repeat(14)}/d`;
    assert.deepEqual(wrapText(`see ${path} now`, 20, { split: true }), ["see", `/a/${"b".repeat(14)}/`, `${"c".repeat(14)}/d now`]);
    assert.deepEqual(wrapText("x".repeat(25), 10, { split: true }), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    assert.deepEqual(breakToken("C:\\Users\\you\\.claude", 12), ["C:\\Users\\", "you\\.claude"]);
  });

  test("a non-breaking space is not a break point", () => {
    assert.deepEqual(wrapText("aaaa\u00a0bbbb cccc\u00a0dddd", 10), ["aaaa\u00a0bbbb", "cccc\u00a0dddd"]);
  });
});
