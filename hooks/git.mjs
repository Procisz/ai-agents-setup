const SUBSTITUTION = "$()";
const MAX_SHELL_DEPTH = 3;
const HEREDOC_MARK = "__wf_heredoc_";
const HEREDOC_TARGET = /^__wf_heredoc_([0-9]+)__$/;
const DELIMITER_STOP = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const BASH_DOUBLE_ESCAPES = new Set(["$", "`", "\"", "\\", "\n"]);
const REDIRECTION = /^(?:[0-9]+)?(?:&>>|&>|>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)(.*)$/s;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "coproc"]);
const PLAIN_WRAPPERS = new Map([
  ["nohup", new Set()],
  ["builtin", new Set()],
  ["noglob", new Set()],
  ["nocorrect", new Set()],
  ["setsid", new Set()],
  ["caffeinate", new Set(["-t", "-w"])],
  ["unbuffer", new Set()],
  ["chronic", new Set()],
  ["arch", new Set(["-arch", "-e", "-d"])],
  ["xcrun", new Set(["--sdk", "-sdk", "--toolchain", "-toolchain", "--log", "-log"])],
  ["rlwrap", new Set(["-a", "-b", "-C", "-D", "-e", "-f", "-g", "-H", "-l", "-o", "-O", "-P", "-q", "-s", "-S", "-t", "-w", "-z"])]
]);
const TEXT_COMMANDS = new Set(["echo", "printf", "print", "grep", "egrep", "fgrep", "rg", "ag", "ack", "man", "info", "help", "which", "whereis", "type", "cat", "less", "more", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "sed", "awk", "ls", "test", "[", "[[", "true", "false", "read", "alias", "unalias", "set", "unset", "cd", "pushd", "popd", "mkdir", "touch", "rm", "rmdir", "cp", "mv", "ln", "chmod", "chown", "stat", "file", "basename", "dirname", "realpath", "readlink", "date", "sleep", "jq", "yq", "tee", "diff", "cmp", "comm", "brew", "apt", "apt-get", "dnf", "yum", "winget", "choco", "scoop", "port", "pacman"]);
const SUDO_WITH_VALUE = new Set(["-u", "-g", "-U", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-R", "--user", "--group", "--other-user", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--command-timeout", "--chroot"]);
const ENV_WITH_VALUE = new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]);
const EXEC_WITH_VALUE = new Set(["-a"]);
const NO_VALUES = new Set();
const TIMEOUT_WITH_VALUE = new Set(["-k", "-s", "--kill-after", "--signal"]);
const NICE_WITH_VALUE = new Set(["-n", "--adjustment"]);
const STDBUF_WITH_VALUE = new Set(["-i", "-o", "-e", "--input", "--output", "--error"]);
const XARGS_WITH_VALUE = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const ENV_SETTERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const POSITIONAL = /\$(?:[@*#0-9]|\{[@*#0-9]|\{?argv\b)/;
const NO_SCRIPT = Object.freeze({ scripts: [], operands: [], stdin: false });
const SHELL_LONG_WITH_VALUE = new Set(["--rcfile", "--init-file"]);
const INTERPRETER = /^(?:python[0-9.]*|py|node|nodejs|deno|bun|perl|ruby|php|osascript)$/;
const OPAQUE_RUNNERS = new Set(["cmd", "powershell", "pwsh", "wsl", "winpty", "start", "watch", "ssh", "su", "script", "flock", "parallel", "runuser", "chroot", "busybox"]);
const PROGRAM_ENV = /^(?:GIT_[A-Z0-9_]*|EDITOR|VISUAL|PAGER)$/i;
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const ENV_SPLIT = new Set(["-S", "--split-string"]);
const GIT_FLAGS = new Set(["--no-pager", "-p", "--paginate", "-P", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice", "--exec-path"]);
const GIT_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
const GIT_ASSIGNED = ["--git-dir=", "--work-tree=", "--namespace=", "--config-env=", "--super-prefix=", "--attr-source=", "--exec-path="];
const WRITE_WORDS = new Set(["add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "clone", "close", "comment", "commit", "config", "create", "delete", "edit", "filter-branch", "gc", "init", "merge", "mv", "notes", "prune", "pull", "push", "rebase", "reflog", "release", "reopen", "replace", "reset", "restore", "revert", "review", "rm", "stash", "submodule", "switch", "tag", "update-index", "update-ref", "worktree"]);
const HEURISTIC_REACH = 8;

function singleQuoteEnd(src, start) {
  const end = src.indexOf("'", start + 1);
  return end < 0 ? src.length : end + 1;
}

function ansiQuoteEnd(src, start) {
  let j = start + 2;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "'") return j + 1;
    j += 1;
  }
  return src.length;
}

function doubleQuoteEnd(src, start) {
  let j = start + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "\"") return j + 1;
    j += 1;
  }
  return src.length;
}

function bracedEnd(src, start) {
  const end = src.indexOf("}", start + 2);
  return end < 0 ? src.length : end + 1;
}

function scanDouble(src, start, out) {
  let text = "\"";
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "\\") {
      text += c + (next ?? "");
      i += 2;
      continue;
    }
    if (c === "\"") return { text: text + "\"", end: i + 1 };
    if (c === "$" && next === "(") {
      i = scanLevel(src, i + 2, ")", out);
      text += SUBSTITUTION;
      continue;
    }
    if (c === "$" && next === "{") {
      const end = bracedEnd(src, i);
      text += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      i = scanLevel(src, i + 1, "`", out);
      text += SUBSTITUTION;
      continue;
    }
    text += c;
    i += 1;
  }
  return { text, end: src.length };
}

function scanLevel(src, start, closer, out) {
  let cur = "";
  let depth = 0;
  let i = start;
  const flush = () => {
    if (cur.trim() !== "") out.push(cur.trim());
    cur = "";
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (closer === "`" && c === "`") {
      flush();
      return i + 1;
    }
    if (closer === ")" && c === ")" && depth === 0) {
      flush();
      return i + 1;
    }
    if (c === "\\") {
      cur += c + (next ?? "");
      i += 2;
      continue;
    }
    if (c === "$" && next === "'") {
      const end = ansiQuoteEnd(src, i);
      cur += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      const end = singleQuoteEnd(src, i);
      cur += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "\"") {
      const scanned = scanDouble(src, i, out);
      cur += scanned.text;
      i = scanned.end;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && next === "(") {
      i = scanLevel(src, i + 2, ")", out);
      cur += SUBSTITUTION;
      continue;
    }
    if (c === "$" && next === "{") {
      const end = bracedEnd(src, i);
      cur += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      i = scanLevel(src, i + 1, "`", out);
      cur += SUBSTITUTION;
      continue;
    }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === "\n" || c === ";") {
      flush();
      i += 1;
      continue;
    }
    if (c === "(") {
      depth += 1;
      flush();
      i += 1;
      continue;
    }
    if (c === ")") {
      if (depth > 0) depth -= 1;
      flush();
      i += 1;
      continue;
    }
    if (c === "|") {
      if (cur.endsWith(">")) {
        cur += c;
        i += 1;
        continue;
      }
      flush();
      i += next === "|" || next === "&" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        flush();
        i += 2;
        continue;
      }
      if (cur.endsWith(">") || cur.endsWith("<") || next === ">") {
        cur += c;
        i += 1;
        continue;
      }
      flush();
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  flush();
  return i;
}

export function splitCommands(text) {
  const out = [];
  scanLevel(String(text ?? "").replace(/\r\n?/g, "\n"), 0, null, out);
  return out;
}

function lex(simple) {
  const s = String(simple ?? "");
  const words = [];
  let value = "";
  let raw = "";
  let inWord = false;
  const push = () => {
    if (inWord) words.push({ value, raw });
    value = "";
    raw = "";
    inWord = false;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      push();
      i += 1;
      continue;
    }
    if (c === "\\") {
      if (next === "\n") {
        i += 2;
        continue;
      }
      inWord = true;
      value += next ?? "";
      raw += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    inWord = true;
    if (c === "$" && next === "'") {
      const end = ansiQuoteEnd(s, i);
      const body = s.slice(i + 2, Math.max(i + 2, end - 1));
      value += body.replace(/\\(.)/g, "$1");
      raw += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      const end = singleQuoteEnd(s, i);
      value += s.slice(i + 1, end > i + 1 && s[end - 1] === "'" ? end - 1 : end);
      raw += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === "\"") {
      let j = i + 1;
      let body = "";
      while (j < s.length) {
        const d = s[j];
        const e = s[j + 1];
        if (d === "\\") {
          if (e !== undefined && BASH_DOUBLE_ESCAPES.has(e)) {
            if (e !== "\n") body += e;
          } else {
            body += d + (e ?? "");
          }
          j += 2;
          continue;
        }
        if (d === "\"") {
          j += 1;
          break;
        }
        body += d;
        j += 1;
      }
      value += body;
      raw += s.slice(i, j);
      i = j;
      continue;
    }
    value += c;
    raw += c;
    i += 1;
  }
  push();
  return words;
}

export function tokenize(simple) {
  return lex(simple).map((word) => word.value);
}

function heredocDelimiter(src, start) {
  let value = "";
  let quoted = false;
  let i = start;
  while (i < src.length && !DELIMITER_STOP.has(src[i])) {
    const c = src[i];
    if (c === "\\") {
      value += src[i + 1] ?? "";
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === "\"") {
      const end = c === "'" ? singleQuoteEnd(src, i) : doubleQuoteEnd(src, i);
      value += src.slice(i + 1, Math.max(i + 1, end - 1));
      quoted = true;
      i = end;
      continue;
    }
    value += c;
    i += 1;
  }
  return { value, quoted, end: i };
}

function readHeredocBodies(src, start, pending) {
  let i = start;
  for (const doc of pending) {
    const lines = [];
    while (i < src.length) {
      const newline = src.indexOf("\n", i);
      const line = src.slice(i, newline < 0 ? src.length : newline);
      i = newline < 0 ? src.length : newline + 1;
      if ((doc.dash ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
      lines.push(doc.dash ? line.replace(/^\t+/, "") : line);
    }
    doc.body = lines.join("\n");
  }
  return i;
}

function arithmeticEnd(src, start) {
  let depth = 0;
  for (let j = start + 1; j < src.length; j += 1) {
    if (src[j] === "(") depth += 1;
    else if (src[j] === ")") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return src.length;
}

export function extractHeredocs(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const heredocs = [];
  const frames = [{ kind: "code", depth: 0 }];
  let pending = [];
  let out = "";
  let i = 0;
  const copy = (end) => {
    out += src.slice(i, end);
    i = end;
  };
  while (i < src.length) {
    const frame = frames[frames.length - 1];
    const c = src[i];
    const next = src[i + 1];
    if (frame.kind === "double") {
      if (c === "\\") copy(i + 2);
      else if (c === "\"") {
        frames.pop();
        copy(i + 1);
      } else if (c === "$" && next === "(") {
        frames.push({ kind: "code", depth: 0 });
        copy(i + 2);
      } else if (c === "`") {
        frames.push({ kind: "tick", depth: 0 });
        copy(i + 1);
      } else copy(i + 1);
      continue;
    }
    if (c === "\\") copy(i + 2);
    else if (c === "'") copy(singleQuoteEnd(src, i));
    else if (c === "$" && next === "'") copy(ansiQuoteEnd(src, i));
    else if (c === "\"") {
      frames.push({ kind: "double" });
      copy(i + 1);
    } else if (c === "$" && next === "(" && src[i + 2] === "(") copy(arithmeticEnd(src, i));
    else if ((c === "$" || c === "<" || c === ">") && next === "(") {
      frames.push({ kind: "code", depth: 0 });
      copy(i + 2);
    } else if (c === "`") {
      if (frame.kind === "tick") frames.pop();
      else frames.push({ kind: "tick", depth: 0 });
      copy(i + 1);
    } else if (c === "(") {
      frame.depth += 1;
      copy(i + 1);
    } else if (c === ")") {
      if (frame.depth > 0) frame.depth -= 1;
      else if (frames.length > 1 && frame.kind === "code") frames.pop();
      copy(i + 1);
    } else if (c === "#" && (i === 0 || /[\s;&|()]/.test(src[i - 1]))) {
      const end = src.indexOf("\n", i);
      copy(end < 0 ? src.length : end);
    } else if (c === "<" && next === "<" && src[i + 2] === "<") copy(i + 3);
    else if (c === "<" && next === "<") {
      let j = i + 2;
      const dash = src[j] === "-";
      if (dash) j += 1;
      while (src[j] === " " || src[j] === "\t") j += 1;
      const word = heredocDelimiter(src, j);
      if (word.value === "" && !word.quoted) {
        copy(i + 2);
        continue;
      }
      const doc = { delimiter: word.value, quoted: word.quoted, dash, body: "" };
      out += `<<${HEREDOC_MARK}${heredocs.length}__`;
      heredocs.push(doc);
      pending.push(doc);
      i = word.end;
    } else if (c === "\n") {
      copy(i + 1);
      if (pending.length > 0) {
        i = readHeredocBodies(src, i, pending);
        pending = [];
      }
    } else copy(i + 1);
  }
  return { text: out, heredocs: heredocs.map(({ delimiter, quoted, body }) => ({ delimiter, quoted, body })) };
}

function spaceRedirections(simple) {
  const src = String(simple ?? "");
  let out = "";
  let wordStart = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      out += c;
      i += 1;
      wordStart = out.length;
      continue;
    }
    if (c === "\\") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    let end = -1;
    if (c === "$" && next === "'") end = ansiQuoteEnd(src, i);
    else if (c === "'") end = singleQuoteEnd(src, i);
    else if (c === "\"") end = doubleQuoteEnd(src, i);
    if (end >= 0) {
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === ">" || c === "<") {
      const word = out.slice(wordStart);
      if (word !== "" && !/^(?:[0-9]+|&)$/.test(word)) {
        const cut = word.endsWith("&") ? out.length - 1 : out.length;
        out = `${out.slice(0, cut)} ${out.slice(cut)}`;
        wordStart = cut + 1;
      }
      let j = i;
      while (j < src.length && "<>&|".includes(src[j])) j += 1;
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function parseSimple(simple, heredocs) {
  const words = lex(spaceRedirections(simple));
  const plain = [];
  const inputs = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const match = REDIRECTION.exec(word.raw);
    if (!match) {
      plain.push(word);
      continue;
    }
    const head = word.raw.slice(0, word.raw.length - match[1].length);
    const op = head.replace(/^[0-9]+/, "");
    let target = null;
    if (match[1] !== "") target = word.value.slice(head.length);
    else if (i + 1 < words.length) {
      i += 1;
      target = words[i].value;
    }
    if (target === null) continue;
    const heredoc = op === "<<" || op === "<<-" ? HEREDOC_TARGET.exec(target) : null;
    if (heredoc) inputs.push(heredocs[Number(heredoc[1])]?.body ?? "");
    else if (op === "<<<") inputs.push(target);
  }
  return { words: plain, inputs };
}

function skipOptions(words, i, withValue) {
  let j = i;
  while (j < words.length) {
    const option = words[j].value;
    if (option === "--") return j + 1;
    if (!option.startsWith("-") || option === "-") return j;
    j += withValue.has(option) ? 2 : 1;
  }
  return j;
}

function assignmentOf(raw, value) {
  const name = raw.slice(0, raw.indexOf("=")).replace(/\+$/, "").replace(/\[.*$/, "");
  return { name, value: value.slice(value.indexOf("=") + 1) };
}

function envSplitString(words, j) {
  const option = words[j]?.value ?? "";
  if (ENV_SPLIT.has(option)) return { text: words[j + 1]?.value ?? "", next: j + 2 };
  if (option.startsWith("--split-string=")) return { text: option.slice(15), next: j + 1 };
  if (/^-S./.test(option)) return { text: option.slice(2), next: j + 1 };
  return null;
}

function commandStart(words) {
  let i = 0;
  const env = [];
  let argsFromInput = false;
  while (i < words.length) {
    const word = words[i];
    if (ASSIGNMENT.test(word.raw)) {
      env.push(assignmentOf(word.raw, word.value));
      i += 1;
      continue;
    }
    if (word.raw === "function") {
      i += 2;
      continue;
    }
    const name = baseName(word.value);
    if (RESERVED.has(word.raw)) {
      i += 1;
      continue;
    }
    if (PLAIN_WRAPPERS.has(name)) {
      i = skipOptions(words, i + 1, PLAIN_WRAPPERS.get(name));
      continue;
    }
    switch (name) {
      case "env": {
        let j = i + 1;
        for (;;) {
          while (j < words.length && ASSIGNMENT.test(words[j].raw)) {
            env.push(assignmentOf(words[j].raw, words[j].value));
            j += 1;
          }
          const split = envSplitString(words, j);
          if (split) {
            const rest = words.slice(split.next).map((w) => w.raw);
            return { index: words.length, env, argsFromInput, nested: [split.text, ...rest].join(" ") };
          }
          const after = skipOptions(words, j, ENV_WITH_VALUE);
          if (after === j) break;
          j = after;
        }
        i = j;
        continue;
      }
      case "command":
      case "time":
        i = skipOptions(words, i + 1, NO_VALUES);
        continue;
      case "exec":
        i = skipOptions(words, i + 1, EXEC_WITH_VALUE);
        continue;
      case "sudo":
      case "doas":
        i = skipOptions(words, i + 1, SUDO_WITH_VALUE);
        continue;
      case "timeout":
      case "gtimeout":
        i = skipOptions(words, i + 1, TIMEOUT_WITH_VALUE);
        if (i < words.length) i += 1;
        continue;
      case "nice":
        i = skipOptions(words, i + 1, NICE_WITH_VALUE);
        continue;
      case "stdbuf":
        i = skipOptions(words, i + 1, STDBUF_WITH_VALUE);
        continue;
      case "xargs":
      case "gxargs":
        argsFromInput = true;
        i = skipOptions(words, i + 1, XARGS_WITH_VALUE);
        continue;
      default:
        break;
    }
    break;
  }
  return { index: i, env, argsFromInput };
}

function baseName(value) {
  const base = String(value).split(/[\\/]/).pop().toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function isGitWord(value) {
  return baseName(value) === "git";
}

function isGhWord(value) {
  return baseName(value) === "gh";
}

function gitInvocationAt(words, index, env, argsFromInput = false) {
  const command = words[index].value;
  const globals = [];
  const config = [];
  let j = index + 1;
  while (j < words.length) {
    const option = words[j].value;
    if (GIT_FLAGS.has(option)) {
      globals.push(option);
      j += 1;
      continue;
    }
    if (GIT_WITH_VALUE.has(option)) {
      const value = words[j + 1]?.value ?? "";
      globals.push(option, value);
      if (option === "-c" || option === "--config-env") config.push(configEntry(value));
      j += 2;
      continue;
    }
    const assigned = GIT_ASSIGNED.find((prefix) => option.startsWith(prefix));
    if (assigned) {
      globals.push(option);
      if (assigned === "--config-env=") config.push(configEntry(option.slice(assigned.length)));
      j += 1;
      continue;
    }
    break;
  }
  const sub = words[j]?.value;
  const known = sub !== undefined && !sub.startsWith("-");
  return {
    tool: "git",
    command,
    globals,
    config,
    env,
    argsFromInput,
    subcommand: known ? sub : null,
    args: words.slice(known ? j + 1 : j).map((w) => w.value)
  };
}

function configEntry(text) {
  const eq = text.indexOf("=");
  return eq < 0 ? { key: text, value: "" } : { key: text.slice(0, eq), value: text.slice(eq + 1) };
}

function ghInvocationAt(words, index, env, argsFromInput = false) {
  return { tool: "gh", command: words[index].value, env, argsFromInput, args: words.slice(index + 1).map((w) => w.value), raw: words.slice(index + 1).map((w) => w.raw) };
}

function shellScripts(name, args) {
  let command = false;
  let stdin = false;
  const script = (at) => {
    if (command) return at < args.length ? { scripts: [args[at]], operands: args.slice(at + 1), stdin: false } : NO_SCRIPT;
    return stdin ? { scripts: [], operands: args.slice(at), stdin: true } : NO_SCRIPT;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--" || arg === "-") return script(i + 1);
    if (arg.startsWith("--")) {
      if (SHELL_LONG_WITH_VALUE.has(arg)) i += 1;
      continue;
    }
    if (!/^[-+][a-zA-Z]+$/.test(arg)) return script(i);
    for (const flag of arg.slice(1)) {
      if (flag === "c") command = true;
      else if (flag === "s") stdin = true;
      else if (flag === "o" || (flag === "O" && name !== "zsh")) i += 1;
    }
  }
  return script(args.length);
}

function carryAssignments(words, state) {
  for (const word of words) {
    if (ASSIGNMENT.test(word.value)) state.carried.push(assignmentOf(word.value, word.value));
  }
}

function readsStdin(args) {
  return args.every((arg) => arg.startsWith("-") || arg.startsWith("+"));
}

function findExecGroups(words) {
  const groups = [];
  for (let i = 0; i < words.length; i += 1) {
    if (!FIND_EXEC.has(words[i].value)) continue;
    const group = [];
    let j = i + 1;
    while (j < words.length && words[j].value !== ";" && words[j].value !== "+") {
      group.push(words[j]);
      j += 1;
    }
    const fromInput = words[j]?.value === "+" || group.some((word) => word.value.includes("{}"));
    if (group.length > 0) groups.push({ words: group, fromInput });
    i = j;
  }
  return groups;
}

function textOf(simple, inputs) {
  return [simple, ...inputs].join("\n");
}

const NODE_FILTER_VALUES = new Set(["--test-name-pattern", "--test-skip-pattern"]);
const PYTEST_FILTER_VALUES = new Set(["-k", "-m", "--deselect"]);
const INLINE_CODE = new Set(["-c", "-e", "--eval", "-p", "--print", "-r", "--require", "--import"]);

function interpreterText(name, args, inputs) {
  const kept = [];
  let pytest = false;
  let inline = false;
  let scriptSeen = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (pytest) {
      if (PYTEST_FILTER_VALUES.has(arg)) {
        i += 1;
        continue;
      }
      if (/^--deselect=/.test(arg) || /^-[km]./.test(arg)) continue;
      kept.push(arg);
      continue;
    }
    if (NODE_FILTER_VALUES.has(optionName(arg))) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "-m" && /^pytest$/.test(args[i + 1] ?? "")) {
      pytest = true;
      kept.push(arg, args[i + 1]);
      i += 1;
      continue;
    }
    if (INLINE_CODE.has(arg)) {
      inline = true;
      kept.push(arg, args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (!arg.startsWith("-") && !inline && !scriptSeen) {
      scriptSeen = true;
      continue;
    }
    kept.push(arg);
  }
  return [name, ...kept, ...inputs].join("\n");
}

function hiddenGitWrite(words, index) {
  for (let k = index + 1; k < words.length; k += 1) {
    const word = words[k];
    if (word.raw !== word.value) continue;
    if (!isGitWord(word.value) && !isGhWord(word.value)) continue;
    if (looksLikeGitWrite(words.slice(k).map((w) => w.value).join(" "))) return true;
  }
  return false;
}

function analyzeWords(words, inputs, simple, context, depth, out, state, fromInput = false) {
  const start = commandStart(words);
  const { index } = start;
  const env = [...state.carried, ...start.env];
  const argsFromInput = fromInput || start.argsFromInput;
  if (typeof start.nested === "string") {
    analyzeNested(start.nested, "env -S", context, depth, out, { carried: env });
    return;
  }
  const word = words[index];
  if (!word) {
    state.carried.push(...start.env);
    return;
  }
  const value = word.value;
  if (value.startsWith("$")) {
    out.push({ tool: "dynamic", git: gitInvocationAt(words, index, env, argsFromInput), gh: ghInvocationAt(words, index, env, argsFromInput), command: value, text: simple });
    return;
  }
  if (isGitWord(value)) {
    out.push(gitInvocationAt(words, index, env, argsFromInput));
    return;
  }
  if (isGhWord(value)) {
    out.push(ghInvocationAt(words, index, env, argsFromInput));
    return;
  }
  const name = baseName(value);
  const args = words.slice(index + 1).map((w) => w.value);
  if (ENV_SETTERS.has(name)) {
    carryAssignments(words.slice(index + 1), state);
    return;
  }
  if (SHELLS.has(name)) {
    const found = shellScripts(name, args);
    const scripts = [...found.scripts, ...inputs];
    if (scripts.length === 0) {
      if (found.stdin || readsStdin(args)) out.push({ tool: "opaque", runner: name, text: context });
      return;
    }
    for (const script of scripts) analyzeNested(script, name, context, depth, out, { carried: env });
    if (scripts.some((script) => POSITIONAL.test(script))) {
      const scan = argsFromInput ? context : found.operands.join(" ");
      if (looksLikeGitWrite(scan)) out.push({ tool: "opaque", runner: name, text: argsFromInput ? context : simple, scan });
    }
    return;
  }
  if (name === "eval") {
    analyzeNested(args.join(" "), name, context, depth, out, state);
    return;
  }
  if (name === "find") {
    for (const group of findExecGroups(words.slice(index + 1))) {
      analyzeWords(group.words, [], group.words.map((w) => w.value).join(" "), context, depth + 1, out, state, group.fromInput);
    }
    return;
  }
  if (INTERPRETER.test(name)) {
    const stdin = inputs.length === 0 && (args.length === 0 || args.includes("-"));
    out.push(stdin ? { tool: "opaque", runner: name, text: context } : { tool: "opaque", runner: name, text: textOf(simple, inputs), scan: interpreterText(name, args, inputs) });
    return;
  }
  if (OPAQUE_RUNNERS.has(name)) {
    out.push({ tool: "opaque", runner: name, text: textOf(simple, inputs) });
    return;
  }
  if (!TEXT_COMMANDS.has(name) && hiddenGitWrite(words, index)) out.push({ tool: "opaque", runner: name, text: simple });
}

function analyzeNested(script, runner, context, depth, out, state) {
  if (depth + 1 > MAX_SHELL_DEPTH) {
    out.push({ tool: "opaque", runner, text: script, deep: true });
    return;
  }
  analyzeText(script, depth + 1, out, context, state);
}

function analyzeText(text, depth, out, context, state) {
  const extracted = extractHeredocs(text);
  for (const simple of splitCommands(extracted.text)) {
    const parsed = parseSimple(simple, extracted.heredocs);
    analyzeWords(parsed.words, parsed.inputs, simple, context, depth, out, state);
  }
}

export function invocations(text) {
  const source = String(text ?? "");
  const out = [];
  analyzeText(source, 0, out, source, { carried: [] });
  return out;
}

export function gitInvocations(text) {
  return invocations(text).filter((entry) => entry.tool === "git");
}

export function ghInvocations(text) {
  return invocations(text).filter((entry) => entry.tool === "gh");
}

function heuristicTokens(text) {
  return String(text ?? "")
    .replace(/[\\"'`()[\]{},;|&=<>]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "");
}

function toolTokens(text) {
  return heuristicTokens(String(text ?? "").replace(/[$:]/g, " "))
    .map((token) => token.replace(/^[-+=?]+/, ""))
    .filter((token) => token !== "");
}

export function looksLikeGitWrite(text) {
  const tokens = heuristicTokens(text);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isGitWord(tokens[i]) && !isGhWord(tokens[i])) continue;
    for (let j = i + 1; j < tokens.length && j <= i + HEURISTIC_REACH; j += 1) {
      if (isGitWord(tokens[j]) || isGhWord(tokens[j])) break;
      if (WRITE_WORDS.has(tokens[j].toLowerCase())) return true;
    }
  }
  return false;
}

export function mentionsTool(text, tool) {
  return toolTokens(text).some((token) => (tool === "git" ? isGitWord(token) : isGhWord(token)));
}

export function invocationText(entry) {
  const words = entry.tool === "git" ? [entry.command, ...entry.globals, ...(entry.subcommand === null ? [] : [entry.subcommand]), ...entry.args] : entry.tool === "gh" ? [entry.command, ...entry.args] : [entry.text ?? ""];
  const text = words.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

const READ = Object.freeze({ level: "read", reason: null });
const WRITE = Object.freeze({ level: "write", reason: null });

function read() {
  return READ;
}

function write(reason = null) {
  return reason === null ? WRITE : { level: "write", reason };
}

function optionName(arg) {
  const eq = arg.indexOf("=");
  return eq < 0 ? arg : arg.slice(0, eq);
}

function abbreviates(arg, names) {
  if (!arg.startsWith("--") || arg === "--") return null;
  const name = optionName(arg);
  if (name.length < 3) return null;
  return names.find((full) => full === name || full.startsWith(name)) ?? null;
}

const BRANCH_LIST_LONG = ["--list", "--all", "--remotes", "--verbose", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color", "--no-color", "--column", "--no-column", "--ignore-case", "--omit-empty", "--abbrev", "--no-abbrev"];
const BRANCH_LIST_SHORT = "arlvi";
const BRANCH_OPTIONAL_VALUE = ["--contains", "--no-contains", "--merged", "--no-merged"];
const BRANCH_LONG_VALUE = ["--points-at", "--sort", "--format", "--set-upstream-to"];
const BRANCH_SETTINGS = ["--set-upstream-to", "--unset-upstream", "--edit-description"];
const BRANCH_CHANGES_LONG = ["--delete", "--move", "--copy", "--force"];
const BRANCH_CHANGES_SHORT = "dDmMcCf";

function classifyBranch(args) {
  let listMode = false;
  let changes = false;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const name = optionName(arg);
      if (BRANCH_LIST_LONG.includes(name)) listMode = true;
      else if (BRANCH_SETTINGS.includes(name)) changes = true;
      else if (abbreviates(arg, BRANCH_CHANGES_LONG)) return write();
      if (!arg.includes("=")) {
        if (BRANCH_LONG_VALUE.includes(name)) i += 1;
        else if (BRANCH_OPTIONAL_VALUE.includes(name) && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i += 1;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let k = 1; k < arg.length; k += 1) {
        const flag = arg[k];
        if (BRANCH_CHANGES_SHORT.includes(flag)) return write();
        if (BRANCH_LIST_SHORT.includes(flag)) listMode = true;
        if (flag === "u") {
          changes = true;
          if (k === arg.length - 1) i += 1;
          break;
        }
      }
      continue;
    }
    positionals.push(arg);
  }
  if (changes) return write();
  return listMode || positionals.length === 0 ? read() : write();
}

const TAG_LIST_LONG = ["--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--no-column", "--ignore-case", "--color", "--omit-empty"];
const TAG_LONG_VALUE = ["--points-at", "--sort", "--format"];

function classifyTag(args) {
  let listMode = false;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const name = optionName(arg);
      if (!TAG_LIST_LONG.includes(name)) return write();
      if (name === "--list") listMode = true;
      if (!arg.includes("=")) {
        if (TAG_LONG_VALUE.includes(name)) i += 1;
        else if (BRANCH_OPTIONAL_VALUE.includes(name) && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i += 1;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let k = 1; k < arg.length; k += 1) {
        const flag = arg[k];
        if (flag === "l") listMode = true;
        else if (flag === "i") continue;
        else if (flag === "n") break;
        else return write();
      }
      continue;
    }
    positionals.push(arg);
  }
  return listMode || positionals.length === 0 ? read() : write();
}

const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "--list", "-l"]);
const CONFIG_WRITE_FLAGS = new Set(["--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "--edit", "-e"]);
const CONFIG_SCOPE_VALUE = new Set(["--file", "-f", "--blob", "--type"]);

function classifyConfig(args) {
  if (args[0] === "get" || args[0] === "list") return read();
  if (["set", "unset", "rename-section", "remove-section", "edit"].includes(args[0])) return write();
  let reading = false;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const name = optionName(arg);
    if (CONFIG_WRITE_FLAGS.has(name)) return write();
    if (CONFIG_READ_FLAGS.has(name)) {
      reading = true;
      continue;
    }
    if (CONFIG_SCOPE_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  return reading || positionals.length <= 1 ? read() : write();
}

const ALWAYS_READ = new Set(["status", "diff", "log", "show", "blame", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "merge-base", "cat-file", "show-ref", "for-each-ref", "check-ignore", "var", "version", "help"]);
const WRITES = new Set(["add", "commit", "push", "init", "reset", "rebase", "clean", "checkout", "switch", "restore", "merge", "pull", "cherry-pick", "revert", "am", "rm"]);
const FETCH_FLAGS = new Set(["--quiet", "-q", "--verbose", "-v", "--tags", "--no-tags", "--all", "--dry-run", "--prune", "-p", "--progress", "--no-progress", "--no-recurse-submodules", "--no-write-fetch-head"]);
const FETCH_FORMS = "the read-only forms are git fetch [origin [<branch>]] with --quiet, --verbose, --tags, --no-tags, --all, --dry-run, --prune or --depth=<n>";

function classifyFetch(args) {
  const refuse = (reason) => write(`${reason}; ${FETCH_FORMS}`);
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (FETCH_FLAGS.has(arg) || /^--depth=\d+$/.test(arg)) continue;
    if (arg === "--depth" && /^\d+$/.test(args[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return refuse(`git fetch ${arg} is not a read-only form`);
    positionals.push(arg);
  }
  if (positionals.length > 2) return refuse("git fetch with more than one branch");
  const [remote, branch] = positionals;
  if (remote !== undefined && (remote.startsWith("-") || remote.startsWith("+") || remote.includes(":") && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) && !/^[^:/]+@[^:]+:/.test(remote))) return refuse(`git fetch from ${remote}`);
  if (branch !== undefined && (branch.includes(":") || branch.startsWith("+") || branch.startsWith("-"))) return refuse(`the refspec ${branch} can move local branches`);
  return read();
}

const GREP_SHORT_WITH_VALUE = "efABCm";

function grepPagers(args) {
  const pagers = [];
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0 && abbreviates(arg, ["--open-files-in-pager"])) pagers.push(arg.slice(eq + 1));
      continue;
    }
    if (!arg.startsWith("-")) continue;
    for (let k = 1; k < arg.length; k += 1) {
      if (arg[k] === "O") {
        pagers.push(arg.slice(k + 1));
        break;
      }
      if (GREP_SHORT_WITH_VALUE.includes(arg[k])) break;
    }
  }
  return pagers;
}

const SAFE_CONFIG_KEY = /^(?:color\..+|column\..+|advice\..+|log\..+|status\..+|i18n\..+|blame\..+|versionsort\..+|user\.(?:name|email)|core\.(?:quotepath|abbrev|autocrlf|safecrlf|precomposeunicode|ignorecase|filemode)|diff\.(?:noprefix|mnemonicprefix|relative|renames|renamelimit|algorithm|context|interhunkcontext|indentheuristic|colormoved|colormovedws|suppressblankempty|statgraphwidth|dirstat|submodule|ignoresubmodules|wserrorhighlight)|grep\.(?:linenumber|column|patterntype|extendedregexp|fullname)|format\.pretty|safe\.directory|init\.defaultbranch|merge\.conflictstyle|branch\.sort|tag\.sort)$/i;
const PAGER_KEY = /^(?:core\.pager|pager\..+)$/i;
const SAFE_PROGRAM = /^(?:|cat|less(?: -[A-Za-z]+)*|more|true|false|:|0|1)$/;
const PROGRAM_VARIABLES = new Set(["GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_ASKPASS", "SSH_ASKPASS", "PAGER", "EDITOR", "VISUAL", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR"]);

function remoteConfigRisk(key, value) {
  const lower = key.toLowerCase();
  if (/^remote\..+\.(?:uploadpack|receivepack|vcs)$/.test(lower)) return `the config override ${key} runs a program`;
  if (/^remote\..+\.fetch$/.test(lower)) {
    const colon = value.indexOf(":");
    const destination = colon < 0 ? "" : value.slice(colon + 1);
    if (destination !== "" && !destination.startsWith("refs/remotes/")) return `the config override ${key} fetches into local branches`;
  }
  return null;
}

function writeRisk(invocation) {
  if (invocation.globals.some((option) => option.startsWith("--exec-path="))) return "an --exec-path override changes which git programs run";
  for (const { key, value } of invocation.config) {
    if (key.toLowerCase() === "core.hookspath") return "a core.hooksPath override skips the git hooks";
    const remote = remoteConfigRisk(key, value);
    if (remote) return remote;
    if (looksLikeGitWrite(value)) return `the config override ${key} runs a git write`;
  }
  for (const { name, value } of invocation.env) {
    if (/^GIT_CONFIG/i.test(name) && /hookspath/i.test(value)) return "a core.hooksPath override skips the git hooks";
    if (PROGRAM_ENV.test(name) && looksLikeGitWrite(value)) return `the variable ${name} runs a git write`;
  }
  return null;
}

function programRisk(invocation) {
  for (const { key, value } of invocation.config) {
    if (SAFE_CONFIG_KEY.test(key)) continue;
    if (PAGER_KEY.test(key) && SAFE_PROGRAM.test(value.trim())) continue;
    return `read-only git may not override the git setting ${key || "(empty)"}: only display settings such as color.* or core.quotepath`;
  }
  if (invocation.globals.some((option) => option === "--config-env" || option.startsWith("--config-env="))) return "read-only git may not use --config-env";
  for (const { name, value } of invocation.env) {
    const upper = name.toUpperCase();
    if (/^GIT_CONFIG/.test(upper)) return `read-only git may not set ${name}`;
    if (PROGRAM_VARIABLES.has(upper) && !SAFE_PROGRAM.test(value.trim())) return `read-only git may not point ${name} at a program`;
  }
  const programArg = invocation.args.find((arg) => /^--(?:ext-diff|textconv)$/.test(arg));
  if (programArg) return `read-only git may not run with ${programArg}`;
  return null;
}

export function classifyGit(invocation) {
  const verdict = classifyGitForm(invocation);
  if (verdict.level !== "read") return verdict;
  const risk = writeRisk(invocation) ?? programRisk(invocation);
  return risk ? write(risk) : verdict;
}

function classifyGitForm(invocation) {
  const sub = invocation.subcommand;
  const args = invocation.args;
  if (invocation.argsFromInput) {
    if (sub === null) return write("a git subcommand read from xargs input cannot be checked");
    if (sub.startsWith("$")) return write("a variable git subcommand cannot be checked");
    if (ALWAYS_READ.has(sub)) return read();
    if (WRITES.has(sub)) return write();
    return write(`git ${sub} with arguments read from xargs input cannot be checked`);
  }
  if (sub === null) return read();
  if (sub.startsWith("$")) return write("a variable git subcommand cannot be checked");
  if (ALWAYS_READ.has(sub)) return read();
  if (WRITES.has(sub)) return write();
  switch (sub) {
    case "fetch":
      return classifyFetch(args);
    case "branch":
      return classifyBranch(args);
    case "tag":
      return classifyTag(args);
    case "stash":
      return args[0] === "list" || args[0] === "show" ? read() : write();
    case "remote": {
      const rest = args[0] === "-v" || args[0] === "--verbose" ? args.slice(1) : args;
      return rest.length === 0 || rest[0] === "show" || rest[0] === "get-url" ? read() : write();
    }
    case "grep":
      return grepPagers(args).some((pager) => looksLikeGitWrite(pager)) ? write("git grep -O runs a git write") : read();
    case "config":
      return classifyConfig(args);
    case "worktree":
      return args[0] === "list" ? read() : write();
    default:
      return write(`git ${sub} is not in the wf read-only git list`);
  }
}

const GH_READ = {
  pr: ["view", "list", "ls", "status", "diff", "checks"],
  issue: ["view", "list", "ls", "status"],
  repo: ["view", "list", "ls"],
  run: ["view", "list", "ls", "watch"],
  workflow: ["view", "list", "ls"],
  release: ["view", "list", "ls"],
  label: ["list", "ls"],
  gist: ["view", "list", "ls"],
  cache: ["list", "ls"],
  secret: ["list", "ls"],
  variable: ["list", "ls", "get"],
  ruleset: ["view", "list", "ls", "check"],
  project: ["view", "list", "ls", "field-list", "item-list"],
  codespace: ["view", "list", "ls"],
  org: ["list", "ls"],
  extension: ["list", "ls"],
  alias: ["list", "ls"],
  config: ["get", "list", "ls"],
  auth: ["status"],
  attestation: ["verify"],
  "gpg-key": ["list", "ls"],
  "ssh-key": ["list", "ls"]
};
const GH_READ_ANY = new Set(["search", "status", "browse", "version", "help", "completion"]);
const GH_GLOBAL_VALUE = new Set(["-R", "--repo", "--hostname"]);
const GH_API_FIELDS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

function ghWords(args) {
  const positionals = [];
  for (let i = 0; i < args.length && positionals.length < 2; i += 1) {
    const arg = args[i];
    if (GH_GLOBAL_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  return positionals;
}

function shellExpands(raw) {
  return /\$/.test(String(raw ?? "").replace(/'[^']*'/g, ""));
}

function classifyGraphql(args, raw) {
  const mutation = write("a gh api graphql mutation writes to GitHub");
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--input" || arg.startsWith("--input=")) return write("gh api graphql --input reads its query from a file or stdin that cannot be checked");
    let value = null;
    let rawValue = null;
    if (GH_API_FIELDS.has(arg)) {
      value = args[i + 1] ?? "";
      rawValue = raw[i + 1] ?? value;
      i += 1;
    } else if (/^--(?:field|raw-field)=/.test(arg)) {
      value = arg.slice(arg.indexOf("=") + 1);
      rawValue = raw[i] ?? arg;
    } else if (/^-[fF]./.test(arg)) {
      value = arg.slice(2);
      rawValue = raw[i] ?? arg;
    }
    if (value === null) {
      if (/\bmutation\b/i.test(arg)) return mutation;
      continue;
    }
    const eq = value.indexOf("=");
    const fieldValue = eq < 0 ? value : value.slice(eq + 1);
    if (fieldValue.startsWith("@")) return write("gh api graphql with a field read from a file or stdin cannot be checked");
    if (shellExpands(rawValue)) return write("gh api graphql with a field built from a shell variable or command cannot be checked");
    if (/\bmutation\b/i.test(value)) return mutation;
  }
  return read();
}

function classifyApi(args, raw = args) {
  let method = null;
  let fields = false;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-X" || arg === "--method") {
      method = (args[i + 1] ?? "").toUpperCase();
      i += 1;
      continue;
    }
    if (arg.startsWith("--method=")) {
      method = arg.slice(9).toUpperCase();
      continue;
    }
    if (/^-X./.test(arg)) {
      method = arg.slice(2).toUpperCase();
      continue;
    }
    if (GH_API_FIELDS.has(arg)) {
      fields = true;
      i += 1;
      continue;
    }
    if (/^--(?:field|raw-field|input)=/.test(arg) || /^-[fF]./.test(arg)) {
      fields = true;
      continue;
    }
    if (!arg.startsWith("-")) positionals.push(arg);
  }
  if (positionals[0] === "graphql") return classifyGraphql(args, raw);
  if (method !== null) return method === "GET" || method === "HEAD" ? read() : write(`gh api ${method} writes to GitHub`);
  return fields ? write("gh api with fields sends a POST that writes to GitHub") : read();
}

export function classifyGh(invocation) {
  const verdict = classifyGhForm(invocation);
  if (!invocation.argsFromInput) return verdict;
  const [group] = ghWords(invocation.args);
  if (verdict.level === "read" && group !== undefined && group !== "api") return verdict;
  return write("gh arguments read from xargs input cannot be checked");
}

function classifyGhForm(invocation) {
  const args = invocation.args;
  const raw = Array.isArray(invocation.raw) && invocation.raw.length === args.length ? invocation.raw : args;
  if (args.includes("--help") || args.includes("-h") || args.includes("--version")) return read();
  const [group, verb] = ghWords(args);
  if (group === undefined) return read();
  if (GH_READ_ANY.has(group)) return read();
  if (group === "api") {
    const at = args.indexOf("api") + 1;
    return classifyApi(args.slice(at), raw.slice(at));
  }
  if (GH_READ[group]?.includes(verb)) return read();
  return write();
}
