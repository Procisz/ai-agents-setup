import readline from "node:readline";
import { MARGIN, PLAIN_UI, visibleLength, wrapText } from "./ui.mjs";

export const MULTI_SELECT_HINT = "up/down move, space toggles, a toggles all, enter confirms, esc cancels";
export const SINGLE_SELECT_HINT = "up/down move, enter chooses, esc cancels";
export const UNICODE_MULTI_HINT = "\u2191/\u2193 move \u00b7 space toggle \u00b7 a all \u00b7 enter confirm \u00b7 esc cancel";
export const UNICODE_SINGLE_HINT = "\u2191/\u2193 move \u00b7 enter choose \u00b7 esc cancel";
export const SHORT_MULTI_HINT = "space toggles, a all, enter ok, esc cancels";
export const SHORT_SINGLE_HINT = "enter chooses, esc cancels";
export const UNICODE_SHORT_MULTI_HINT = "space toggle \u00b7 a all \u00b7 enter ok \u00b7 esc cancel";
export const UNICODE_SHORT_SINGLE_HINT = "enter choose \u00b7 esc cancel";
export const CHOOSE_WITH_ENTER = "press enter to choose";
export const DETAIL_MAX_LINES = 2;

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function createSelectState(items, min = 0) {
  return {
    items,
    min,
    cursor: 0,
    status: "",
    checked: items.map((item) => Boolean(item.locked) || item.checked === true)
  };
}

export function createChoiceState(items) {
  const start = items.findIndex((item) => item.checked === true);
  return { items, cursor: start >= 0 ? start : 0, status: "" };
}

export function selectedValues(state) {
  return state.items.filter((item, index) => state.checked[index]).map((item) => item.value);
}

function detailOf(state, index = state.cursor) {
  const item = state.items[index];
  if (!item || item.detail === undefined || item.detail === null) return "";
  const text = typeof item.detail === "function" ? item.detail(state.checked ? selectedValues(state) : [], item) : item.detail;
  return oneLine(text);
}

export function detailLines(text, { margin = "", limit, ui = PLAIN_UI }) {
  if (!text) return [];
  const lead = `${margin}  ${ui.sym("detail")} `;
  const wrapped = wrapText(text, limit - visibleLength(lead), { split: true });
  const lines = wrapped.length > DETAIL_MAX_LINES ? [...wrapped.slice(0, DETAIL_MAX_LINES - 1), wrapped.slice(DETAIL_MAX_LINES - 1).join(" ")] : wrapped;
  const pad = " ".repeat(visibleLength(lead));
  return lines.map((line, index) => ui.fit([{ text: `${index === 0 ? lead : pad}${line}`, style: "cyan" }], limit));
}

function itemLine(state, index, { width, limit, ui, single }) {
  const item = state.items[index];
  const here = index === state.cursor;
  const cursor = here ? ui.sym("cursor") : " ".repeat(ui.sym("cursor").length);
  const hint = oneLine(item.hint);
  if (single) {
    return ui.fit(
      [
        { text: `${cursor} `, style: "cyan" },
        { text: String(item.label).padEnd(width), style: here ? "bold cyan" : null },
        { text: hint ? `  ${hint}` : "", style: "dim" }
      ],
      limit
    );
  }
  const ticked = state.checked[index];
  const mark = ticked ? ui.sym("on") : ui.sym("off");
  const markStyle = item.locked ? "dim" : ticked ? "green" : null;
  const labelStyle = item.locked ? "dim" : here ? "bold cyan" : null;
  return ui.fit(
    [
      { text: `${cursor} `, style: "cyan" },
      { text: mark, style: markStyle },
      { text: ` ${String(item.label).padEnd(width)}`, style: labelStyle },
      { text: hint ? `  ${hint}` : "", style: "dim" }
    ],
    limit
  );
}

function itemLimit(columns, ui) {
  return Math.max(20, (columns || 80) - 1 - (ui.rich ? MARGIN.length : 0));
}

function labelWidth(state) {
  return Math.max(0, ...state.items.map((item) => String(item.label).length));
}

export function renderItems(state, columns, ui = PLAIN_UI) {
  const options = { width: labelWidth(state), limit: itemLimit(columns, ui), ui, single: false };
  const lines = state.items.map((item, index) => itemLine(state, index, options));
  lines.push(state.status ? ui.fit([{ text: `  ${state.status}`, style: "yellow" }], options.limit) : "");
  return lines;
}

export function renderChoices(state, columns, ui = PLAIN_UI) {
  const options = { width: labelWidth(state), limit: itemLimit(columns, ui), ui, single: true };
  return state.items.map((item, index) => itemLine(state, index, options));
}

export function listWindow(count, cursor, size) {
  if (size >= count) return { start: 0, end: count };
  const span = Math.max(1, size);
  const start = Math.min(Math.max(0, cursor - Math.floor((span - 1) / 2)), count - span);
  return { start, end: start + span };
}

export function keyHint(ui, single, room) {
  const unicode = ui.unicode && ui.rich;
  const full = unicode ? (single ? UNICODE_SINGLE_HINT : UNICODE_MULTI_HINT) : single ? SINGLE_SELECT_HINT : MULTI_SELECT_HINT;
  if (visibleLength(full) <= room) return full;
  return unicode ? (single ? UNICODE_SHORT_SINGLE_HINT : UNICODE_SHORT_MULTI_HINT) : single ? SHORT_SINGLE_HINT : SHORT_MULTI_HINT;
}

export function renderPrompt(state, { title, help, columns, rows, ui = PLAIN_UI, single = false }) {
  const limit = Math.max(20, (columns || 80) - 1);
  const margin = ui.rich ? MARGIN : "";
  const count = state.items.length;
  const hasDetail = state.items.some((item) => item.detail !== undefined && item.detail !== null);
  const detailOptions = { margin, limit, ui };
  const detailRows = hasDetail ? Math.max(1, ...state.items.map((item, index) => detailLines(detailOf(state, index), detailOptions).length)) : 0;
  const fixed = 1 + detailRows + 2;
  const height = Number.isInteger(rows) && rows > 0 ? rows - 1 : Infinity;
  let showHelp = Boolean(help);
  let room = height - fixed - (showHelp ? 1 : 0);
  if (room < count && showHelp && room - 2 < 3) {
    showHelp = false;
    room += 1;
  }
  const windowed = room < count;
  const { start, end } = windowed ? listWindow(count, state.cursor, room - 2) : { start: 0, end: count };
  const out = [];
  out.push(ui.fit([{ text: margin }, { text: "? ", style: "cyan" }, { text: oneLine(title), style: "bold" }], limit));
  if (showHelp) out.push(ui.fit([{ text: `${margin}  ${oneLine(help)}`, style: "dim" }], limit));
  const options = { width: labelWidth(state), limit: itemLimit(columns, ui), ui, single };
  const more = (symbol, hidden, where) => (hidden > 0 ? ui.fit([{ text: `${margin}  ${ui.sym(symbol)} ${hidden} more ${where}`, style: "dim" }], limit) : "");
  if (windowed) out.push(more("above", start, "above"));
  for (let index = start; index < end; index += 1) out.push(`${margin}${itemLine(state, index, options)}`);
  if (windowed) out.push(more("below", count - end, "below"));
  if (hasDetail) {
    const detail = detailLines(detailOf(state), detailOptions);
    out.push(...detail, ...Array.from({ length: detailRows - detail.length }, () => ""));
  }
  out.push(ui.fit([{ text: `${margin}  ${keyHint(ui, single, limit - visibleLength(margin) - 2)}`, style: "dim" }], limit));
  out.push(state.status ? ui.fit([{ text: `${margin}  ${state.status}`, style: "yellow" }], limit) : "");
  return out;
}

export function applyKey(state, key) {
  const count = state.items.length;
  const unlocked = state.items.map((item, index) => index).filter((index) => !state.items[index].locked);
  state.status = "";
  if (key === "up" && count > 0) state.cursor = (state.cursor + count - 1) % count;
  else if (key === "down" && count > 0) state.cursor = (state.cursor + 1) % count;
  else if (key === "space" && count > 0) {
    const item = state.items[state.cursor];
    if (item.locked) state.status = `${item.label} is ${oneLine(item.hint) || "locked"} and stays ticked`;
    else state.checked[state.cursor] = !state.checked[state.cursor];
  } else if (key === "all") {
    const every = unlocked.every((index) => state.checked[index]);
    for (const index of unlocked) state.checked[index] = !every;
  } else if (key === "confirm") {
    const values = selectedValues(state);
    if (values.length >= state.min) return { done: true, values };
    state.status = `pick at least ${state.min}`;
  } else if (key === "cancel") {
    return { done: true, values: null };
  }
  return { done: false, values: null };
}

export function applyChoiceKey(state, key) {
  const count = state.items.length;
  state.status = "";
  if (key === "up" && count > 0) state.cursor = (state.cursor + count - 1) % count;
  else if (key === "down" && count > 0) state.cursor = (state.cursor + 1) % count;
  else if (key === "confirm" && count > 0) return { done: true, value: state.items[state.cursor].value };
  else if (key === "space" && count > 0) state.status = CHOOSE_WITH_ENTER;
  else if (key === "cancel") return { done: true, value: null };
  return { done: false, value: null };
}

export function keyOf(text, key = {}) {
  if (key.ctrl && key.name === "c") return "cancel";
  if (key.name === "escape") return "cancel";
  if (key.name === "up" || key.name === "k") return "up";
  if (key.name === "down" || key.name === "j") return "down";
  if (key.name === "space" || text === " ") return "space";
  if (key.name === "a") return "all";
  if (key.name === "return" || key.name === "enter") return "confirm";
  return null;
}

function runPrompt({ input, output, ui, render, apply, pick }) {
  return new Promise((resolve) => {
    const raw = Boolean(input.isTTY) && typeof input.setRawMode === "function";
    const tty = Boolean(output.isTTY);
    const columns = () => output.columns || 80;
    const rows = () => output.rows || 24;
    let drawn = 0;
    const clear = () => {
      if (drawn === 0) return;
      readline.moveCursor(output, 0, -drawn);
      readline.clearScreenDown(output);
      drawn = 0;
    };
    const draw = () => {
      clear();
      const lines = render(columns(), rows());
      output.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    };
    const finish = (value) => {
      input.off("keypress", onKey);
      if (raw) input.setRawMode(false);
      input.pause();
      clear();
      if (tty) output.write(SHOW_CURSOR);
      resolve(value);
    };
    const onKey = (text, key) => {
      const action = keyOf(text, key);
      if (action === null) return;
      const result = apply(action);
      if (result.done) finish(pick(result));
      else draw();
    };
    readline.emitKeypressEvents(input);
    if (raw) input.setRawMode(true);
    input.on("keypress", onKey);
    if (tty) output.write(HIDE_CURSOR);
    draw();
    input.resume();
  });
}

export function multiSelect({ input, output, ui = PLAIN_UI, title, help, items, min = 0 }) {
  const state = createSelectState(items, min);
  return runPrompt({
    input,
    output,
    ui,
    render: (columns, rows) => renderPrompt(state, { title, help, columns, rows, ui }),
    apply: (action) => applyKey(state, action),
    pick: (result) => result.values
  });
}

export function singleSelect({ input, output, ui = PLAIN_UI, title, help, items }) {
  const state = createChoiceState(items);
  return runPrompt({
    input,
    output,
    ui,
    render: (columns, rows) => renderPrompt(state, { title, help, columns, rows, ui, single: true }),
    apply: (action) => applyChoiceKey(state, action),
    pick: (result) => result.value
  });
}

export function terminalMultiSelect({ input = process.stdin, output = process.stdout, ui = PLAIN_UI } = {}) {
  return (options) => multiSelect({ input, output, ui, ...options });
}

export function terminalSelect({ input = process.stdin, output = process.stdout, ui = PLAIN_UI } = {}) {
  return (options) => singleSelect({ input, output, ui, ...options });
}
