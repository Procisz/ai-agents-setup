export const STYLE_CODES = Object.freeze({
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39]
});

export const SYMBOLS = Object.freeze({
  ok: ["\u2714", "+"],
  warn: ["\u26a0", "!"],
  fail: ["\u2716", "x"],
  info: ["\u2139", "i"],
  cursor: ["\u276f", ">"],
  on: ["\u25c9", "[x]"],
  off: ["\u25ef", "[ ]"],
  detail: ["\u21b3", "->"],
  create: ["\u271a", "+"],
  update: ["\u270e", "~"],
  remove: ["\u2716", "-"],
  remap: ["*", "*"],
  sep: ["\u00b7", "-"],
  ellipsis: ["\u2026", "..."],
  above: ["\u2191", "^"],
  below: ["\u2193", "v"],
  step: ["", ">>"]
});

export const BOX = Object.freeze({
  unicode: { tl: "\u256d", tr: "\u256e", bl: "\u2570", br: "\u256f", h: "\u2500", v: "\u2502" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
});

export const MARGIN = "  ";

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const SPACES = /[\t\n\v\f\r ]+/g;
const GLUE = /\u00a0/g;
export const NBSP = "\u00a0";

function flag(value) {
  return value !== undefined && value !== null && value !== "";
}

export function forceColorValue(env = {}) {
  if (env.FORCE_COLOR === undefined) return null;
  return !/^(0|false)$/i.test(String(env.FORCE_COLOR));
}

export function colorEnabled({ stream, env = {} } = {}) {
  const forced = forceColorValue(env);
  if (forced !== null) return forced;
  if (flag(env.NO_COLOR)) return false;
  if (env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY);
}

export function unicodeEnabled({ env = {}, platform = process.platform } = {}) {
  if (env.TERM === "dumb") return false;
  if (platform === "win32") return flag(env.WT_SESSION);
  return true;
}

export function richEnabled({ stream } = {}) {
  return Boolean(stream?.isTTY);
}

export function stripAnsi(text) {
  return String(text).replace(ANSI, "");
}

export function visibleLength(text) {
  return [...stripAnsi(text)].length;
}

function chars(text) {
  return [...String(text)];
}

export function breakToken(token, width) {
  const limit = Math.max(10, width);
  const parts = [];
  let rest = chars(token);
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    let cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\")) + 1;
    if (cut < Math.ceil(limit / 3)) cut = limit;
    parts.push(rest.slice(0, cut).join(""));
    rest = rest.slice(cut);
  }
  parts.push(rest.join(""));
  return parts;
}

export function wrapText(text, width, { split = false } = {}) {
  const limit = Math.max(10, width);
  const words = String(text ?? "").replace(SPACES, " ").trim().split(" ").filter((word) => word !== "");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (split && chars(word).length > limit) {
      if (line !== "") lines.push(line);
      const pieces = breakToken(word, limit);
      lines.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1];
    } else if (line === "") line = word;
    else if (chars(line).length + 1 + chars(word).length <= limit) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

export function createUi({ color = false, unicode = false, rich = false, columns = 80 } = {}) {
  const width = () => {
    const value = typeof columns === "function" ? columns() : columns;
    return Number.isInteger(value) && value > 0 ? value : 80;
  };
  const sym = (name) => {
    const pair = SYMBOLS[name];
    if (!pair) return "";
    return unicode ? pair[0] : pair[1];
  };
  const paint = (style, text) => {
    const value = String(text);
    if (!color || !style || value === "") return value;
    const names = String(style).split(/\s+/).filter((name) => Object.hasOwn(STYLE_CODES, name));
    if (names.length === 0) return value;
    const open = names.map((name) => `\u001b[${STYLE_CODES[name][0]}m`).join("");
    const close = [...names].reverse().map((name) => `\u001b[${STYLE_CODES[name][1]}m`).join("");
    return `${open}${value}${close}`;
  };
  const fit = (segments, limit = width() - 1) => {
    const max = Math.max(4, limit);
    const parts = segments.filter((part) => part && part.text !== undefined && part.text !== null && part.text !== "");
    const total = parts.reduce((sum, part) => sum + chars(part.text).length, 0);
    if (total <= max) return parts.map((part) => paint(part.style, part.text)).join("");
    const tail = sym("ellipsis");
    let room = max - chars(tail).length;
    let out = "";
    for (const part of parts) {
      if (room <= 0) break;
      const piece = chars(part.text).slice(0, room).join("");
      room -= chars(piece).length;
      out += paint(part.style, piece);
    }
    return out + tail;
  };
  const spaceAfter = (first) => Math.max(20, Math.min(width(), 100) - visibleLength(first) - 1);
  const indentWrap = (text, { first = MARGIN, rest = MARGIN, style = null, wrap = true } = {}) => {
    const lines = wrap ? wrapText(text, Math.min(spaceAfter(first), spaceAfter(rest)), { split: true }) : [String(text ?? "")];
    return lines.map((line, index) => `${index === 0 ? first : rest}${paint(style, line.replace(GLUE, " "))}`);
  };
  const KIND = {
    ok: { symbol: "ok", style: "green" },
    warn: { symbol: "warn", style: "yellow" },
    fail: { symbol: "fail", style: "red" },
    info: { symbol: "info", style: "cyan" }
  };
  const ui = {
    color,
    unicode,
    rich,
    width,
    sym,
    paint,
    fit,
    status(kind, text, { plain, wrap = true } = {}) {
      if (!rich) return [plain ?? text];
      const spec = KIND[kind] ?? KIND.info;
      const mark = paint(spec.style, sym(spec.symbol));
      const pad = " ".repeat(chars(sym(spec.symbol)).length + 1);
      return indentWrap(text, { first: `${MARGIN}${mark} `, rest: `${MARGIN}${pad}`, wrap });
    },
    text(text, { style = null } = {}) {
      if (!rich) return [text];
      return indentWrap(text, { style });
    },
    para(text, { first = MARGIN, rest = first, style = null } = {}) {
      if (!rich) return [`${first}${text}`];
      return indentWrap(text, { first, rest, style });
    },
    row(label, value, { pad = 0 } = {}) {
      if (!rich) return [`${label} ${value}`];
      const first = `${MARGIN}${paint("dim", label.padEnd(pad))}  `;
      const rest = " ".repeat(visibleLength(first));
      return breakToken(String(value ?? ""), spaceAfter(first)).map((piece, index) => `${index === 0 ? first : rest}${piece}`);
    },
    blank() {
      return rich ? [""] : [];
    },
    header({ name, version, about }) {
      if (!rich) return [];
      const box = unicode ? BOX.unicode : BOX.ascii;
      const title = `${name} ${version} ${sym("sep")} installer`;
      const inner = Math.max(24, Math.min(width() - 6, Math.max(chars(title).length, chars(about).length) + 4));
      const body = [title, ...wrapText(about, inner - 4)];
      const row = (text, style) => `${MARGIN}${paint("cyan", box.v)}  ${paint(style, text)}${" ".repeat(Math.max(0, inner - 2 - chars(text).length))}${paint("cyan", box.v)}`;
      return [
        "",
        `${MARGIN}${paint("cyan", `${box.tl}${box.h.repeat(inner)}${box.tr}`)}`,
        row("", null),
        ...body.map((line, index) => row(line, index === 0 ? "bold cyan" : null)),
        row("", null),
        `${MARGIN}${paint("cyan", `${box.bl}${box.h.repeat(inner)}${box.br}`)}`,
        ""
      ];
    },
    step({ number, total, emoji = "", title }) {
      if (!rich) return [`Step ${number} of ${total}: ${title}`];
      const icon = unicode ? emoji : sym("step");
      const label = paint("dim", `Step ${number} of ${total}`);
      return ["", `${MARGIN}${label}  ${icon ? `${icon} ` : ""}${paint("bold cyan", title)}`];
    },
    explain(lines) {
      if (!rich) return lines.map((line) => `  ${line}`);
      if (lines.every((line) => visibleLength(line) <= spaceAfter(MARGIN))) return lines.map((line) => `${MARGIN}${line}`);
      return indentWrap(lines.join(" "));
    },
    done(title, answer) {
      if (!rich) return [`${title}: ${answer}`];
      const mark = sym("ok");
      const first = `${MARGIN}${paint("green", mark)} `;
      const rest = `${MARGIN}${" ".repeat(chars(mark).length + 1)}`;
      const lines = wrapText(`${title}: ${answer}`, spaceAfter(first), { split: true });
      return lines.map((line, index) => {
        if (index > 0) return `${rest}${line.replace(GLUE, " ")}`;
        const head = line.startsWith(`${title}:`) ? `${paint("bold", title)}${line.slice(title.length)}` : line;
        return `${first}${head.replace(GLUE, " ")}`;
      });
    },
    table(rows, { header = null, indent = MARGIN, gap = 2 } = {}) {
      const all = header ? [header, ...rows] : rows;
      const count = Math.max(0, ...all.map((row) => row.length));
      const widths = [];
      for (let column = 0; column < count; column += 1) {
        widths.push(Math.max(0, ...all.map((row) => chars(cellText(row[column])).length)));
      }
      const span = widths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, count - 1);
      if (rich && chars(indent).length > chars(MARGIN).length && chars(indent).length + span > width() - 1) indent = MARGIN;
      const render = (row, headerRow) =>
        indent +
        row
          .map((cell, column) => {
            const textValue = cellText(cell);
            const padded = column === row.length - 1 ? textValue : textValue + " ".repeat(widths[column] - chars(textValue).length + gap);
            const style = headerRow ? "dim" : cellStyle(cell);
            return paint(style, padded);
          })
          .join("")
          .replace(/\s+$/, "");
      return [...(header ? [render(header, true)] : []), ...rows.map((row) => render(row, false))];
    }
  };
  return ui;
}

function cellText(cell) {
  if (cell && typeof cell === "object") return String(cell.text ?? "");
  return String(cell ?? "");
}

function cellStyle(cell) {
  return cell && typeof cell === "object" ? cell.style ?? null : null;
}

export const PLAIN_UI = createUi();

export function detectUi({ stream = process.stdout, env = process.env, platform = process.platform } = {}) {
  const rich = richEnabled({ stream, env });
  return createUi({
    color: colorEnabled({ stream, env }),
    unicode: rich && unicodeEnabled({ env, platform }),
    rich,
    columns: () => stream?.columns || 80
  });
}
