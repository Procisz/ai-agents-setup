import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createUi, stripAnsi, visibleLength } from "../lib/ui.mjs";
import {
  CHOOSE_WITH_ENTER,
  DETAIL_MAX_LINES,
  MULTI_SELECT_HINT,
  SHORT_MULTI_HINT,
  SHORT_SINGLE_HINT,
  SINGLE_SELECT_HINT,
  UNICODE_MULTI_HINT,
  UNICODE_SHORT_MULTI_HINT,
  UNICODE_SHORT_SINGLE_HINT,
  UNICODE_SINGLE_HINT,
  applyChoiceKey,
  applyKey,
  createChoiceState,
  createSelectState,
  detailLines,
  keyHint,
  keyOf,
  listWindow,
  multiSelect,
  renderChoices,
  renderItems,
  renderPrompt,
  selectedValues,
  singleSelect,
  terminalMultiSelect,
  terminalSelect
} from "../lib/prompt.mjs";

const RICH = createUi({ rich: true, unicode: true, color: true, columns: 80 });
const RICH_MONO = createUi({ rich: true, unicode: true, color: false, columns: 80 });
const RICH_ASCII = createUi({ rich: true, unicode: false, color: false, columns: 80 });

const items = [
  { label: "context-cache", value: "context-cache", checked: true, locked: true, hint: "required" },
  { label: "javascript", value: "javascript", checked: true, locked: false, hint: "JavaScript conventions" },
  { label: "seo", value: "seo", checked: false, locked: false, hint: "Search engine checks" }
];

function streams({ tty = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (tty) output.isTTY = true;
  let written = "";
  output.on("data", (chunk) => {
    written += chunk.toString();
  });
  return { input, output, text: () => written };
}

describe("multi-select state", () => {
  test("a locked item stays ticked and explains why", () => {
    const state = createSelectState(items);
    applyKey(state, "space");
    assert.equal(state.checked[0], true);
    assert.equal(state.status, "context-cache is required and stays ticked");
    const coder = createSelectState([{ label: "coder", value: "coder", checked: true, locked: true, hint: "needed by every tier" }]);
    applyKey(coder, "space");
    assert.equal(coder.status, "coder is needed by every tier and stays ticked");
  });

  test("a locked item is ticked even when its checked flag is false", () => {
    assert.deepEqual(selectedValues(createSelectState([{ label: "x", value: "x", checked: false, locked: true, hint: "required" }])), ["x"]);
  });

  test("space toggles, arrows wrap, a toggles every unlocked item", () => {
    const state = createSelectState(items);
    applyKey(state, "up");
    assert.equal(state.cursor, 2);
    applyKey(state, "space");
    assert.deepEqual(selectedValues(state), ["context-cache", "javascript", "seo"]);
    applyKey(state, "all");
    assert.deepEqual(selectedValues(state), ["context-cache"]);
    applyKey(state, "all");
    assert.deepEqual(selectedValues(state), ["context-cache", "javascript", "seo"]);
    applyKey(state, "down");
    assert.equal(state.cursor, 0);
  });

  test("confirm returns the ticked values, cancel returns null and min holds", () => {
    assert.deepEqual(applyKey(createSelectState(items), "confirm"), { done: true, values: ["context-cache", "javascript"] });
    assert.deepEqual(applyKey(createSelectState(items), "cancel"), { done: true, values: null });
    const strict = createSelectState(items.map((item) => ({ ...item, locked: false, checked: false })), 1);
    assert.deepEqual(applyKey(strict, "confirm"), { done: false, values: null });
    assert.equal(strict.status, "pick at least 1");
  });
});

describe("single-select state", () => {
  const choices = [
    { value: "install", label: "Install", hint: "write" },
    { value: "change", label: "Change choices", hint: "again" },
    { value: "cancel", label: "Cancel", hint: "stop" }
  ];

  test("starts on the checked item, moves with wrap and confirms only with enter", () => {
    const state = createChoiceState(choices.map((item, index) => ({ ...item, checked: index === 1 })));
    assert.equal(state.cursor, 1);
    applyChoiceKey(state, "down");
    applyChoiceKey(state, "down");
    assert.equal(state.cursor, 0);
    assert.deepEqual(applyChoiceKey(state, "confirm"), { done: true, value: "install" });
    applyChoiceKey(state, "up");
    assert.deepEqual(applyChoiceKey(state, "cancel"), { done: true, value: null });
    assert.deepEqual(applyChoiceKey(state, "all"), { done: false, value: null });
  });

  test("space on a single choice chooses nothing, keeps the cursor and says to press enter", () => {
    const state = createChoiceState(choices.map((item, index) => ({ ...item, checked: index === 0 })));
    assert.deepEqual(applyChoiceKey(state, "space"), { done: false, value: null }, "a reflexive space after the toggle lists must not install");
    assert.equal(state.cursor, 0);
    assert.equal(state.status, CHOOSE_WITH_ENTER);
    assert.ok(renderPrompt(state, { title: "Install now?", columns: 80, single: true }).includes(`  ${CHOOSE_WITH_ENTER}`));
    applyChoiceKey(state, "down");
    assert.equal(state.status, "", "the next key clears the note");
  });

  test("renders a cursor, aligned labels and dim hints", () => {
    assert.deepEqual(renderChoices(createChoiceState(choices), 80), ["> Install         write", "  Change choices  again", "  Cancel          stop"]);
    assert.deepEqual(stripAnsi(renderChoices(createChoiceState(choices), 80, RICH)[0]), "\u276f Install         write");
  });
});

describe("rendering", () => {
  test("plain rendering keeps the ASCII cursor, boxes and hints and fits the width", () => {
    const state = createSelectState(items);
    assert.deepEqual(renderItems(state, 200), ["> [x] context-cache  required", "  [x] javascript     JavaScript conventions", "  [ ] seo            Search engine checks", ""]);
    const narrow = renderItems(state, 24);
    assert.ok(narrow.slice(0, 3).every((line) => line.length <= 23 && line.endsWith("...")), JSON.stringify(narrow));
  });

  test("a rich terminal uses single-width markers, colors and a dim locked item", () => {
    const state = createSelectState(items);
    const lines = renderItems(state, 80, RICH);
    assert.deepEqual(lines.map(stripAnsi), ["\u276f \u25c9 context-cache  required", "  \u25c9 javascript     JavaScript conventions", "  \u25ef seo            Search engine checks", ""]);
    assert.ok(lines[0].includes("\u001b[2m\u25c9\u001b[22m"), "the locked marker is dim");
    assert.ok(lines[1].includes("\u001b[32m\u25c9\u001b[39m"), "a ticked marker is green");
    assert.ok(lines[0].startsWith("\u001b[36m\u276f"), "the cursor is cyan");
    const columns = lines.slice(0, 3).map((line, index) => [...stripAnsi(line)].join("").indexOf(items[index].hint));
    assert.equal(new Set(columns).size, 1, `the hint column lines up: ${columns}`);
  });

  test("renderPrompt shows the title, help, items, the detail of the cursor item, the key hint and the status", () => {
    const withDetail = items.map((item) => ({ ...item, detail: (values) => `${item.label}: ${values.length} ticked` }));
    const state = createSelectState(withDetail);
    assert.deepEqual(renderPrompt(state, { title: "Skills", help: "for the coder", columns: 80 }), [
      "? Skills",
      "  for the coder",
      "> [x] context-cache  required",
      "  [x] javascript     JavaScript conventions",
      "  [ ] seo            Search engine checks",
      "  -> context-cache: 2 ticked",
      `  ${MULTI_SELECT_HINT}`,
      ""
    ]);
    applyKey(state, "space");
    const rich = renderPrompt(state, { title: "Skills", columns: 80, ui: RICH }).map(stripAnsi);
    assert.deepEqual(rich, [
      "  ? Skills",
      "  \u276f \u25c9 context-cache  required",
      "    \u25c9 javascript     JavaScript conventions",
      "    \u25ef seo            Search engine checks",
      "    \u21b3 context-cache: 2 ticked",
      `    ${UNICODE_MULTI_HINT}`,
      "    context-cache is required and stays ticked"
    ]);
  });

  test("a list without details has no detail line, and the single-select hint differs", () => {
    const lines = renderPrompt(createChoiceState([{ value: "a", label: "A" }]), { title: "Pick", columns: 80, single: true });
    assert.deepEqual(lines, ["? Pick", "> A", `  ${SINGLE_SELECT_HINT}`, ""]);
    assert.ok(renderPrompt(createChoiceState([{ value: "a", label: "A" }]), { title: "Pick", columns: 80, single: true, ui: RICH_MONO }).includes(`    ${UNICODE_SINGLE_HINT}`));
  });

  test("an ASCII terminal keeps the ASCII markers and key hint", () => {
    const lines = renderPrompt(createSelectState(items), { title: "Skills", columns: 80, ui: RICH_ASCII });
    assert.equal(lines[1], "  > [x] context-cache  required");
    assert.ok(lines.includes(`    ${MULTI_SELECT_HINT}`));
    assert.ok(lines.every((line) => /^[\x20-\x7e]*$/.test(line)), "only ASCII");
  });

  test("no rendered line is wider than the terminal", () => {
    const long = [{ label: "x", value: "x", hint: "word ".repeat(40), detail: "detail ".repeat(30) }];
    for (const ui of [createUi(), RICH, RICH_ASCII]) {
      for (const line of renderPrompt(createSelectState(long), { title: "t ".repeat(60), help: "h ".repeat(60), columns: 50, ui })) {
        assert.ok([...stripAnsi(line)].length <= 49, `${JSON.stringify(stripAnsi(line))} fits 49 columns`);
      }
    }
  });
});

describe("a detail longer than the terminal line", () => {
  const DEBUGGER = "Untick the debugger: a repeated failure gets one more coder round, then the report";
  const agents = [
    { label: "reviewer", value: "reviewer", checked: true, hint: "reviews the change", detail: "Untick the reviewer: the orchestrator reviews it" },
    { label: "debugger", value: "debugger", checked: true, hint: "fixes a repeated failure", detail: (values) => (values.includes("debugger") ? DEBUGGER : "Without the debugger") }
  ];

  test("wraps onto a second line at 80 columns instead of cutting the end", () => {
    const state = createSelectState(agents);
    state.cursor = 1;
    const lines = renderPrompt(state, { title: "Which agents should wf install?", columns: 80, ui: RICH }).map(stripAnsi);
    assert.deepEqual(lines.slice(3, 5), ["    \u21b3 Untick the debugger: a repeated failure gets one more coder round, then", "      the report"]);
    for (const line of lines) assert.ok(visibleLength(line) <= 79, JSON.stringify(line));
    assert.ok(!lines.some((line) => line.includes("\u2026")), "nothing is cut");
  });

  test("keeps the same height when the cursor moves to a short detail, so the list does not jump", () => {
    const state = createSelectState(agents);
    const short = renderPrompt(state, { title: "t", columns: 80, ui: RICH_MONO });
    applyKey(state, "down");
    const long = renderPrompt(state, { title: "t", columns: 80, ui: RICH_MONO });
    assert.equal(short.length, long.length);
    assert.deepEqual(short.slice(3, 5).map(stripAnsi), ["    \u21b3 Untick the reviewer: the orchestrator reviews it", ""]);
    applyKey(state, "space");
    assert.equal(renderPrompt(state, { title: "t", columns: 80, ui: RICH_MONO }).length, long.length - 1, "the reserved rows follow the longest detail with the current ticks");
  });

  test(`uses at most ${DETAIL_MAX_LINES} lines and cuts only what is left after them`, () => {
    const lines = detailLines("word ".repeat(40).trim(), { margin: "  ", limit: 40, ui: RICH_ASCII });
    assert.equal(lines.length, DETAIL_MAX_LINES);
    assert.ok(lines[0].startsWith("    -> word"), JSON.stringify(lines[0]));
    assert.ok(lines[1].startsWith(`${" ".repeat(7)}word`) && lines[1].endsWith("..."), JSON.stringify(lines[1]));
    for (const line of lines) assert.ok(visibleLength(line) <= 40, JSON.stringify(line));
    assert.deepEqual(detailLines("", { limit: 40 }), []);
    assert.deepEqual(detailLines("fits", { limit: 40 }), ["  -> fits"]);
  });
});

describe("a list taller than the terminal", () => {
  const skills = Array.from({ length: 14 }, (_, index) => ({ label: `skill-${String(index + 1).padStart(2, "0")}`, value: `s${index + 1}`, checked: index % 2 === 0, hint: "a skill" }));

  test("listWindow keeps the cursor inside a window of the given size", () => {
    assert.deepEqual(listWindow(14, 0, 7), { start: 0, end: 7 });
    assert.deepEqual(listWindow(14, 6, 7), { start: 3, end: 10 });
    assert.deepEqual(listWindow(14, 13, 7), { start: 7, end: 14 });
    assert.deepEqual(listWindow(5, 4, 7), { start: 0, end: 5 });
  });

  for (const ui of [createUi(), RICH_MONO, RICH_ASCII]) {
    test(`renders at most rows - 1 lines with the cursor row and more markers (rich ${ui.rich}, unicode ${ui.unicode})`, () => {
      const state = createSelectState(skills);
      for (const [moves, key] of [[0, null], [5, "down"], [1, "up"], [9, "down"]]) {
        for (let step = 0; step < moves; step += 1) applyKey(state, key);
        const lines = renderPrompt(state, { title: "Skills for the orchestrator", help: "the main thread", columns: 80, rows: 14, ui }).map(stripAnsi);
        assert.ok(lines.length <= 13, `${lines.length} lines fit 14 rows: ${JSON.stringify(lines)}`);
        const label = skills[state.cursor].label;
        assert.ok(lines.some((line) => line.includes(ui.sym("cursor")) && line.includes(label)), `the cursor row ${label} is drawn`);
        const shown = lines.filter((line) => /skill-\d\d/.test(line)).length;
        const above = lines.find((line) => line.includes("more above"));
        const below = lines.find((line) => line.includes("more below"));
        const hidden = (line) => (line ? Number(/(\d+) more/.exec(line)[1]) : 0);
        assert.equal(shown + hidden(above) + hidden(below), skills.length, "every item is shown or counted");
      }
    });
  }

  test("the window follows the cursor across the wrap from the first to the last item", () => {
    const state = createSelectState(skills);
    applyKey(state, "up");
    const lines = renderPrompt(state, { title: "t", help: "h", columns: 80, rows: 14 });
    assert.ok(lines.some((line) => line.startsWith("> [") && line.includes("skill-14")), JSON.stringify(lines));
    assert.ok(lines.some((line) => line.includes("more above")));
    assert.ok(!lines.some((line) => line.includes("more below")));
  });

  test("a very short terminal drops the help line before shrinking the list below three items", () => {
    const lines = renderPrompt(createSelectState(skills), { title: "t", help: "the help line", columns: 80, rows: 8 });
    assert.ok(!lines.includes("  the help line"), JSON.stringify(lines));
    assert.ok(lines.length <= 7, JSON.stringify(lines));
    assert.equal(lines.filter((line) => /skill-\d\d/.test(line)).length, 2);
  });

  test("a list that fits draws every item with no more markers", () => {
    const lines = renderPrompt(createSelectState(skills), { title: "t", help: "h", columns: 80, rows: 40 });
    assert.equal(lines.filter((line) => /skill-\d\d/.test(line)).length, 14);
    assert.ok(!lines.some((line) => line.includes("more")));
  });

  test("multiSelect on a 14 row terminal never draws 14 or more lines, so the redraw reaches its first line", async () => {
    const { input, output, text } = streams({ tty: true });
    output.rows = 14;
    output.columns = 80;
    const pending = multiSelect({ input, output, ui: RICH, title: "Skills for the orchestrator", help: "the main thread", items: skills });
    for (const key of ["j", "j", "j", " ", "k", "\r"]) input.write(key);
    await pending;
    const moves = [...text().matchAll(/\u001b\[(\d+)A/g)].map((match) => Number(match[1]));
    assert.ok(moves.length >= 5, "it redraws after each key");
    assert.ok(moves.every((count) => count < 14), `cursor moves ${moves} stay inside 14 rows`);
  });
});

describe("key hint", () => {
  test("a narrow terminal gets the short key hint instead of a cut one", () => {
    for (const [ui, full, short] of [[RICH_MONO, UNICODE_MULTI_HINT, UNICODE_SHORT_MULTI_HINT], [RICH_ASCII, MULTI_SELECT_HINT, SHORT_MULTI_HINT], [createUi(), MULTI_SELECT_HINT, SHORT_MULTI_HINT]]) {
      const wide = renderPrompt(createSelectState(items), { title: "t", columns: 80, ui });
      assert.ok(wide.some((line) => line.trim() === full), `${full} at 80 columns`);
      const narrow = renderPrompt(createSelectState(items), { title: "t", columns: 60, ui });
      assert.ok(narrow.some((line) => line.trim() === short), JSON.stringify(narrow));
      assert.ok(narrow.every((line) => visibleLength(line) <= 59));
    }
    assert.equal(keyHint(RICH_MONO, true, 80), UNICODE_SINGLE_HINT);
    assert.equal(keyHint(RICH_MONO, true, 30), UNICODE_SHORT_SINGLE_HINT);
    assert.equal(keyHint(createUi(), true, 30), SHORT_SINGLE_HINT);
  });
});

describe("keys", () => {
  test("maps keys to actions", () => {
    assert.equal(keyOf("", { name: "up" }), "up");
    assert.equal(keyOf("k", { name: "k" }), "up");
    assert.equal(keyOf("", { name: "down" }), "down");
    assert.equal(keyOf(" ", {}), "space");
    assert.equal(keyOf("a", { name: "a" }), "all");
    assert.equal(keyOf("", { name: "return" }), "confirm");
    assert.equal(keyOf("", { name: "escape" }), "cancel");
    assert.equal(keyOf("", { name: "c", ctrl: true }), "cancel");
    assert.equal(keyOf("x", { name: "x" }), null);
  });
});

describe("prompts on streams", () => {
  test("multiSelect reads keys, redraws and clears its lines when done", async () => {
    const { input, output, text } = streams();
    const pending = multiSelect({ input, output, title: "Skills for the coder", items });
    input.write("j");
    input.write("j");
    input.write(" ");
    input.write("\r");
    assert.deepEqual(await pending, ["context-cache", "javascript", "seo"]);
    const written = text();
    assert.ok(written.includes("? Skills for the coder\n"), written);
    assert.ok(written.includes(MULTI_SELECT_HINT), written);
    assert.ok(written.endsWith("\u001b[0J"), "the list is cleared so the caller prints one result line");
    assert.ok(!written.includes("\u001b[?25l"), "no cursor codes when the output is not a terminal");
  });

  test("multiSelect hides the cursor on a terminal and shows it again on escape", async () => {
    const { input, output, text } = streams({ tty: true });
    const pending = terminalMultiSelect({ input, output, ui: RICH })({ title: "t", items });
    input.write("\u001b");
    input.end();
    assert.equal(await pending, null);
    assert.ok(text().startsWith("\u001b[?25l"));
    assert.ok(text().endsWith("\u001b[?25h"));
  });

  test("singleSelect returns the chosen value", async () => {
    const { input, output, text } = streams();
    const pending = terminalSelect({ input, output })({ title: "Install now?", items: [{ value: "install", label: "Install" }, { value: "cancel", label: "Cancel" }] });
    input.write("j");
    input.write("\r");
    assert.equal(await pending, "cancel");
    assert.ok(text().includes("? Install now?"));
  });

  test("singleSelect resolves null on ctrl+c", async () => {
    const { input, output } = streams();
    const pending = singleSelect({ input, output, title: "t", items: [{ value: "a", label: "A" }] });
    input.write("\u0003");
    assert.equal(await pending, null);
  });
});
