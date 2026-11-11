import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyGh,
  classifyGit,
  extractHeredocs,
  ghInvocations,
  gitInvocations,
  invocationText,
  invocations,
  looksLikeGitWrite,
  mentionsTool,
  splitCommands,
  tokenize
} from "../hooks/git.mjs";

function gitOf(text) {
  const found = gitInvocations(text);
  assert.equal(found.length, 1, `expected one git invocation in ${JSON.stringify(text)}, got ${found.length}`);
  return found[0];
}

function levelOf(text) {
  return classifyGit(gitOf(text));
}

function ghLevel(text) {
  const found = ghInvocations(text);
  assert.equal(found.length, 1, `expected one gh invocation in ${JSON.stringify(text)}`);
  return classifyGh(found[0]);
}

describe("splitCommands", () => {
  const table = [
    ["splits on semicolons, && and ||", "a; b && c || d", ["a", "b", "c", "d"]],
    ["splits on pipes, |& and background &", "a | b |& c & d", ["a", "b", "c", "d"]],
    ["splits on newlines", "a\nb\r\nc", ["a", "b", "c"]],
    ["keeps separators inside single quotes", "echo 'a; b && c'", ["echo 'a; b && c'"]],
    ["keeps separators inside double quotes", "echo \"a | b\"", ["echo \"a | b\""]],
    ["returns command substitution contents as extra commands", "echo $(git log; git status)", ["git log", "git status", "echo $()"]],
    ["returns backtick contents as extra commands", "echo `git show`", ["git show", "echo $()"]],
    ["descends into substitutions inside double quotes", "echo \"x $(git push) y\"", ["git push", "echo \"x $() y\""]],
    ["treats subshell parentheses as separators", "(cd a && git push)", ["cd a", "git push"]],
    ["handles nested parentheses inside a substitution", "echo $( (git push) )", ["git push", "echo $()"]],
    ["keeps fd redirections such as 2>&1 in the command", "git log 2>&1 | head", ["git log 2>&1", "head"]],
    ["keeps &> redirections in the command", "git log &> out.txt", ["git log &> out.txt"]],
    ["drops comments that start a word", "ls # git push", ["ls"]],
    ["keeps a hash inside a word", "echo a#b", ["echo a#b"]],
    ["treats process substitution like command substitution", "diff <(git show HEAD) b", ["git show HEAD", "diff $() b"]],
    ["ignores empty commands", " ; ;; ", []]
  ];
  for (const [name, input, expected] of table) {
    test(name, () => {
      assert.deepEqual(splitCommands(input), expected);
    });
  }
});

describe("tokenize", () => {
  const table = [
    ["splits on whitespace", "git  -C  dir\tstatus", ["git", "-C", "dir", "status"]],
    ["removes single quotes", "echo 'a b'", ["echo", "a b"]],
    ["removes double quotes", "echo \"a b\"", ["echo", "a b"]],
    ["honors backslash escapes outside quotes", "g\\it co\\ mmit", ["git", "co mmit"]],
    ["keeps backslashes before ordinary characters inside double quotes", "\"C:\\Git\\git.exe\"", ["C:\\Git\\git.exe"]],
    ["unescapes quotes inside double quotes", "\"a\\\"b\"", ["a\"b"]],
    ["joins adjacent quoted parts into one word", "'gi'\"t\" push", ["git", "push"]],
    ["keeps an empty quoted word", "git ''", ["git", ""]],
    ["keeps the last character of an unterminated single quote", "bash -c 'git status", ["bash", "-c", "git status"]],
    ["removes a line continuation", "git \\\n push", ["git", "push"]],
    ["reads ANSI-C quoting as its body", "$'git' push", ["git", "push"]]
  ];
  for (const [name, input, expected] of table) {
    test(name, () => {
      assert.deepEqual(tokenize(input), expected);
    });
  }
});

describe("gitInvocations", () => {
  const table = [
    ["finds a plain subcommand", "git status -s", "status", ["-s"]],
    ["skips -C with its path", "git -C ../x commit -m y", "commit", ["-m", "y"]],
    ["skips -c with its value", "git -c user.name=x push", "push", []],
    ["skips --git-dir in both forms", "git --git-dir .git --git-dir=.git log", "log", []],
    ["skips --work-tree in both forms", "git --work-tree w --work-tree=w diff", "diff", []],
    ["skips --no-pager, -p and --bare", "git --no-pager -p --bare show", "show", []],
    ["reports a null subcommand for --version", "git --version", null, ["--version"]],
    ["reports a null subcommand for bare git", "git", null, []],
    ["strips leading VAR=value words", "GIT_PAGER=cat A=1 git log", "log", []],
    ["strips env with options and assignments", "env -i -u X A=1 git push", "push", []],
    ["strips command, exec, nohup and time", "command exec nohup time git push", "push", []],
    ["strips sudo with -u and its value", "sudo -u root -E git push", "push", []],
    ["strips doas like sudo", "doas -u root git push", "push", []],
    ["strips timeout with its options and its duration", "timeout -k 5 --signal KILL 30s git push", "push", []],
    ["strips nice with -n and its value", "nice -n 10 git push", "push", []],
    ["strips nice with a numeric option", "nice -10 git push", "push", []],
    ["strips stdbuf with attached and separate modes", "stdbuf -oL -e 0 git push", "push", []],
    ["strips builtin, noglob and nocorrect", "builtin noglob nocorrect git push", "push", []],
    ["strips a bare xargs", "xargs git commit -m x", "commit", ["-m", "x"]],
    ["strips xargs with its options and their values", "xargs -0 -n1 -I {} -P 4 git add {}", "add", ["{}"]],
    ["strips a wrapper given by its path", "/usr/bin/env git push", "push", []],
    ["recognizes git.exe", "git.exe commit", "commit", []],
    ["recognizes a path ending in /git", "/usr/bin/git commit", "commit", []],
    ["recognizes a Windows path ending in \\git.exe", "\"C:\\Program Files\\Git\\cmd\\git.exe\" push", "push", []],
    ["matches the command word case-insensitively in the classifier, though the live Bash(*git*) if filter is case-sensitive and never starts the guard for GIT (D68 soft limit)", "GIT push", "push", []],
    ["ignores redirections before the subcommand", "git 2>/dev/null commit", "commit", []],
    ["ignores redirections before the command word", ">/dev/null git commit", "commit", []],
    ["strips shell keywords before the command word", "if true; then git reset; fi", "reset", []],
    ["strips a group brace", "{ git push; }", "push", []]
  ];
  for (const [name, input, subcommand, args] of table) {
    test(name, () => {
      const found = gitOf(input);
      assert.equal(found.subcommand, subcommand);
      assert.deepEqual(found.args, args);
    });
  }

  test("does not treat git inside quotes or as an argument as an invocation", () => {
    assert.deepEqual(gitInvocations("echo 'git push' \"git commit\""), []);
    assert.deepEqual(gitInvocations("grep -r git ."), []);
  });

  test("records config overrides and environment assignments with their values", () => {
    const found = gitOf("GIT_EDITOR=vim git -c core.hooksPath=/dev/null --config-env=user.name=NAME commit");
    assert.deepEqual(found.config, [
      { key: "core.hooksPath", value: "/dev/null" },
      { key: "user.name", value: "NAME" }
    ]);
    assert.deepEqual(found.env, [{ name: "GIT_EDITOR", value: "vim" }]);
  });

  test("marks a variable or substitution command word as dynamic", () => {
    for (const text of ["$G commit", "\"$G\" commit", "`which git` commit", "${GIT} commit"]) {
      const found = invocations(text);
      assert.equal(found.length, 1, text);
      assert.equal(found[0].tool, "dynamic", text);
      assert.equal(found[0].git.subcommand, "commit", text);
    }
  });

  test("finds git in a find -exec group", () => {
    assert.deepEqual(gitInvocations("find . -name '*.js' -exec git add {} \\;").map((item) => item.subcommand), ["add"]);
    assert.deepEqual(gitInvocations("find . -execdir git rm {} +").map((item) => item.subcommand), ["rm"]);
  });

  test("reads an eval script as commands", () => {
    assert.deepEqual(gitInvocations("eval \"git commit -m x\"").map((item) => item.subcommand), ["commit"]);
  });

  test("an assignment exported or set by an earlier statement reaches the env of a later git or gh invocation", () => {
    const table = [
      ["export GIT_PAGER=less; git log", [{ name: "GIT_PAGER", value: "less" }]],
      ["export A=1 B=2 && git status", [{ name: "A", value: "1" }, { name: "B", value: "2" }]],
      ["declare -x A=1; typeset -x B=2; local C=3; readonly D=4; git status", ["A", "B", "C", "D"].map((name, i) => ({ name, value: String(i + 1) }))],
      ["export \"A=x y\"; git status", [{ name: "A", value: "x y" }]],
      ["A=1; export A; git status", [{ name: "A", value: "1" }]],
      ["export A=1; B=2 git status", [{ name: "A", value: "1" }, { name: "B", value: "2" }]],
      ["export A=1; bash -c 'git status'", [{ name: "A", value: "1" }]],
      ["eval 'export A=1'; git status", [{ name: "A", value: "1" }]],
      ["git status; export A=1", []]
    ];
    for (const [text, env] of table) assert.deepEqual(gitOf(text).env, env, text);
    assert.deepEqual(ghInvocations("export GH_PAGER=less; gh pr view 1")[0].env, [{ name: "GH_PAGER", value: "less" }]);
  });

  test("invocationText rebuilds the git or gh command", () => {
    assert.equal(invocationText(gitOf("git -C dir push --force origin main")), "git -C dir push --force origin main");
    assert.equal(invocationText(ghInvocations("gh pr create --fill")[0]), "gh pr create --fill");
  });
});

describe("git inside a script run by a shell", () => {
  const nested = [
    ["bash -c 'git commit -m x'", ["commit"]],
    ["sh -c \"git push origin main\"", ["push"]],
    ["zsh -c 'cd src && git add .'", ["add"]],
    ["dash -c 'git stash'", ["stash"]],
    ["ksh -c 'git reset --hard'", ["reset"]],
    ["fish -c 'git push'", ["push"]],
    ["bash -lc 'git commit -am x'", ["commit"]],
    ["bash -o pipefail -c 'git push | tail -1'", ["push"]],
    ["timeout 30 bash -c 'git commit -m x'", ["commit"]],
    ["env A=1 sudo -u me sh -c 'git push'", ["push"]],
    ["xargs -I{} bash -c 'git add {}' < files.txt", ["add"]],
    ["/bin/bash -c 'git tag v1'", ["tag"]],
    ["BASH.EXE -c 'git push'", ["push"]],
    ["echo $(bash -c 'git rev-parse HEAD; git commit -m x')", ["rev-parse", "commit"]],
    ["bash <<'SH'\ngit commit -m x\nSH", ["commit"]],
    ["sh <<-SH\n\tgit push\n\tSH", ["push"]],
    ["bash <<< 'git commit -m x'", ["commit"]],
    ["sh -c \"bash -c 'git commit -m x'\"", ["commit"]],
    ["bash -euo pipefail -c 'git push'", ["push"]],
    ["bash -c -- 'git commit -m x'", ["commit"]],
    ["bash -c - 'git push'", ["push"]],
    ["bash -O extglob -c 'git push'", ["push"]],
    ["bash --rcfile .bashrc -c 'git push'", ["push"]],
    ["bash -c 'git status' -- 'git push'", ["status"]],
    ["bash -- -c 'git push'", []],
    ["bash scripts/check.sh --commit", []]
  ];
  for (const [text, expected] of nested) {
    test(`finds ${JSON.stringify(expected)} in ${JSON.stringify(text)}`, () => {
      assert.deepEqual(gitInvocations(text).map((item) => item.subcommand), expected);
    });
  }

  test("looks three shells deep and reports a deeper script as opaque", () => {
    assert.deepEqual(gitInvocations("sh -c \"sh -c 'sh -c \\\"git push\\\"'\"").map((item) => item.subcommand), ["push"]);
    const deep = invocations("sh -c \"sh -c 'sh -c \\\"sh -c git\\\\ push\\\"'\"");
    assert.equal(deep.length, 1);
    assert.equal(deep[0].tool, "opaque");
    assert.equal(deep[0].deep, true);
    assert.equal(looksLikeGitWrite(deep[0].text), true);
  });

  test("a -c script that runs its positional parameters is opaque over the operands after it", () => {
    for (const text of ["bash -c '\"$@\"' _ git commit -am x", "sh -c '$*' sh git push", "zsh -c '\"$@\"' _ gh pr merge 1", "bash -c '\"${@}\"' _ git push", "zsh -c '$argv' _ git commit -m x"]) {
      const found = invocations(text).filter((entry) => entry.tool === "opaque");
      assert.equal(found.length, 1, text);
      assert.equal(found[0].text, text, text);
      assert.equal(looksLikeGitWrite(found[0].scan), true, text);
    }
    for (const text of ["bash -c '\"$@\"' _ git status", "bash -c 'echo hi' _ git push", "bash -c 'git status' -- 'git push'"]) {
      assert.deepEqual(invocations(text).filter((entry) => entry.tool === "opaque"), [], text);
    }
  });

  test("a shell started with -s reads its script from stdin, so it is opaque over the whole command whatever its operands", () => {
    for (const text of ["echo '\"$@\"' | bash -s git commit -am x", "echo 'git push' | sh -s foo", "echo 'git push' | bash -xs -- foo"]) {
      const found = invocations(text);
      assert.equal(found.length, 1, text);
      assert.equal(found[0].tool, "opaque", text);
      assert.equal(found[0].text, text, text);
    }
  });

  test("a heredoc script with positional parameters is checked over the operands of its shell", () => {
    const found = invocations("bash -s git commit -am x <<'SH'\n\"$@\"\nSH").filter((entry) => entry.tool === "opaque");
    assert.equal(found.length, 1);
    assert.equal(looksLikeGitWrite(found[0].scan), true);
  });

  test("a -c script with positional parameters fed by xargs is scanned over the whole command", () => {
    const found = invocations("echo git push | xargs bash -c '\"$@\"' _").filter((entry) => entry.tool === "opaque");
    assert.equal(found.length, 1);
    assert.equal(looksLikeGitWrite(found[0].scan), true);
    assert.deepEqual(invocations("git ls-files | xargs bash -c 'wc -l \"$@\"' _").filter((entry) => entry.tool === "opaque"), []);
  });

  test("a heredoc body fed to a plain command is data, not commands", () => {
    assert.deepEqual(gitInvocations("git commit -m \"$(cat <<'EOF'\nFix it\ngit push origin main\nEOF\n)\"").map((item) => item.subcommand), ["commit"]);
    assert.deepEqual(gitInvocations("cat > notes.md <<EOF\ngit reset --hard\nEOF"), []);
  });

  test("a shell that reads stdin is opaque over the whole command", () => {
    const found = invocations("echo 'git push' | bash");
    assert.equal(found.length, 1);
    assert.equal(found[0].tool, "opaque");
    assert.equal(found[0].text, "echo 'git push' | bash");
  });

  test("an interpreter's test filters and script path are not scanned, its inline code and trailing arguments are", () => {
    const scanOf = (text) => invocations(text)[0];
    assert.equal(looksLikeGitWrite(scanOf("node --test --test-name-pattern='git commit' test/").scan), false);
    assert.equal(looksLikeGitWrite(scanOf("python3 -m pytest -k 'git and push' -m slow").scan), false);
    assert.equal(looksLikeGitWrite(scanOf("node -e \"process.argv\" git push").scan), true);
    assert.equal(looksLikeGitWrite(scanOf("python3 -c \"import os; os.system('git push')\"").scan), true);
    assert.equal(scanOf("node --test --test-name-pattern='git commit' test/").text, "node --test --test-name-pattern='git commit' test/", "the message still shows the command as typed");
  });

  test("xargs and find -exec with {} or + mark the arguments as read from input", () => {
    assert.equal(gitInvocations("echo x | xargs git branch")[0].argsFromInput, true);
    assert.equal(gitInvocations("find . -exec git add {} +")[0].argsFromInput, true);
    assert.equal(gitInvocations("find . -exec git status \\;")[0].argsFromInput, false);
    assert.equal(gitInvocations("git branch")[0].argsFromInput, false);
  });

  test("env -S and its long form are analysed as a nested script", () => {
    for (const text of ["env -S 'git commit -m x'", "env -S'git commit -m x'", "env --split-string='git commit -m x'", "env FOO=1 --split-string 'git commit -m x'"]) {
      const found = gitInvocations(text);
      assert.equal(found.length, 1, text);
      assert.equal(found[0].subcommand, "commit", text);
    }
  });

  test("wrapper flags, arch, xcrun, rlwrap and the function keyword are seen through", () => {
    for (const text of ["caffeinate -i git push", "caffeinate -t 5 git push", "setsid -f git push", "unbuffer -p git push", "chronic -e git push", "arch -arm64 git push", "arch -arch x86_64 git push", "xcrun --sdk macosx git push", "rlwrap -f words git push", "function f { git push; }"]) {
      assert.equal(gitInvocations(text)[0]?.subcommand, "push", text);
    }
  });

  test("an unknown command word followed by an unquoted git write is opaque, a text command is not", () => {
    assert.equal(invocations("mywrapper -x git push")[0].tool, "opaque");
    assert.deepEqual(invocations("echo git push"), []);
    assert.deepEqual(invocations("mywrapper 'git push'"), []);
  });

  test("interpreters and remote runners are opaque over their own text", () => {
    for (const text of ["python3 -c \"import subprocess; subprocess.run(['git', 'push'])\"", "node -e \"require('child_process').execSync('git commit -m x')\"", "cmd //c \"git push\"", "wsl git commit -m x", "ssh host 'git push'"]) {
      const found = invocations(text);
      assert.equal(found.length, 1, text);
      assert.equal(found[0].tool, "opaque", text);
      assert.equal(looksLikeGitWrite(found[0].text), true, text);
    }
  });
});

describe("extractHeredocs", () => {
  test("replaces each heredoc body with a numbered marker and keeps the commands after it", () => {
    const result = extractHeredocs("cat <<EOF > a\nx\nEOF\ngit status");
    assert.equal(result.text, "cat <<__wf_heredoc_0__ > a\ngit status");
    assert.deepEqual(result.heredocs, [{ delimiter: "EOF", quoted: false, body: "x" }]);
  });

  test("strips leading tabs from the lines of <<-", () => {
    assert.equal(extractHeredocs("sh <<-X\n\tgit push\n\tX").heredocs[0].body, "git push");
  });

  test("ignores here-strings, arithmetic shifts and << inside quotes or comments", () => {
    for (const text of ["cat <<< 'x'", "echo $((1 << 2))", "echo '<<EOF'", "ls # <<EOF"]) {
      assert.deepEqual(extractHeredocs(text).heredocs, [], text);
    }
  });

  test("takes the rest of the text as the body when the delimiter line is missing", () => {
    assert.equal(extractHeredocs("bash <<EOF\ngit push\ngit status").heredocs[0].body, "git push\ngit status");
  });
});

describe("looksLikeGitWrite", () => {
  const writes = ["git push", "G=git; $G commit", "subprocess.run(['git','commit','-m','x'])", "git -C dir -c a=b commit", "gh pr create", "/usr/bin/git reset --hard"];
  for (const text of writes) {
    test(`sees a write in ${JSON.stringify(text)}`, () => {
      assert.equal(looksLikeGitWrite(text), true);
    });
  }
  const reads = ["git status", "git log --oneline", "node scripts/git-push-helper.mjs", "echo digit push", "gh pr view 3", "git diff | bash", ""];
  for (const text of reads) {
    test(`sees no write in ${JSON.stringify(text)}`, () => {
      assert.equal(looksLikeGitWrite(text), false);
    });
  }

  test("mentionsTool matches whole git and gh words only", () => {
    assert.equal(mentionsTool("G=git; $G status", "git"), true);
    assert.equal(mentionsTool("legit digit .github", "git"), false);
    assert.equal(mentionsTool("X=gh; $X pr view", "gh"), true);
  });
});

describe("classifyGit: read-only forms", () => {
  const reads = [
    "git status",
    "git diff --stat HEAD~1",
    "git log --oneline -5",
    "git show HEAD:src/a.js",
    "git blame -L 1,5 a.js",
    "git grep -n slugify",
    "git grep -O foo",
    "git grep -iO -e x",
    "git grep --open-files-in-pager foo",
    "git ls-files -z",
    "git ls-tree HEAD",
    "git rev-parse --show-toplevel",
    "git rev-list --count HEAD",
    "git describe --tags",
    "git shortlog -sn",
    "git merge-base HEAD main",
    "git cat-file -p HEAD",
    "git show-ref",
    "git for-each-ref refs/heads",
    "git check-ignore a.txt",
    "git var GIT_EDITOR",
    "git version",
    "git help commit",
    "git fetch origin",
    "git branch",
    "git branch -a",
    "git branch -vv",
    "git branch --list 'feat/*'",
    "git branch --show-current",
    "git branch --contains HEAD",
    "git branch --merged main",
    "git branch --format '%(refname)' --sort=-committerdate",
    "git tag",
    "git tag -l 'v*'",
    "git tag --list",
    "git tag -n5",
    "git tag --contains HEAD",
    "git tag --points-at HEAD",
    "git stash list",
    "git stash show -p stash@{0}",
    "git remote",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "git config --get user.email",
    "git config --list",
    "git config -l --show-origin",
    "git config --global --get-regexp alias",
    "git config get user.name",
    "git config user.name",
    "git worktree list",
    "git --version",
    "git -C sub status",
    "git -c core.pager=cat log",
    "GIT_PAGER=cat git log",
    "git diff --output=out.patch"
  ];
  for (const text of reads) {
    test(`${text} is read-only`, () => {
      assert.deepEqual(levelOf(text), { level: "read", reason: null });
    });
  }
});


describe("classifyGit: write forms", () => {
  const writes = [
    "git add .",
    "git add -A src",
    "git commit -m 'wf: add slugify'",
    "git commit -am x",
    "git commit -F .work/t/msg.txt",
    "git commit --amend -m x",
    "git commit --no-verify -m x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "GIT_EDITOR='git push' git commit",
    "git push",
    "git push origin main",
    "git push -u origin feature/x",
    "git push --force",
    "git push origin +main",
    "git push --tags",
    "git push --delete origin old",
    "git push origin --delete old",
    "git push origin :old",
    "git push --force-with-lease origin feature/x",
    "git push origin HEAD:main",
    "git reset --hard origin/main",
    "git branch -d -r origin/old",
    "git commit --amend --no-edit",
    "git branch feature/x",
    "git branch -t feature/x origin/feature/x",
    "git branch -u origin/main",
    "git branch --set-upstream-to=origin/main",
    "git branch -d old",
    "git branch -D old",
    "git branch --del old",
    "git branch -M new",
    "git branch -c old new",
    "git branch -f main HEAD~1",
    "git init",
    "git tag v1.0",
    "git tag -a v1.0 -m x",
    "git tag -d v1.0",
    "git tag --delete v1.0",
    "git tag -f v1.0",
    "git reset --hard",
    "git rebase main",
    "git clean -fd",
    "git checkout -- .",
    "git checkout -b x",
    "git switch main",
    "git restore src/a.js",
    "git stash",
    "git stash push -m x",
    "git stash pop",
    "git merge main",
    "git pull",
    "git cherry-pick abc",
    "git revert HEAD",
    "git rm a.js",
    "git am patch.mbox",
    "git remote add origin x",
    "git remote set-url origin x",
    "git config user.name x",
    "git config --unset user.name",
    "git config set user.name x",
    "git worktree add ../x"
  ];
  for (const text of writes) {
    test(`${text} is a write`, () => {
      assert.deepEqual(levelOf(text), { level: "write", reason: null });
    });
  }
});

describe("classifyGit: read-looking forms refused with a reason", () => {
  const table = [
    ["git --exec-path=/tmp/x status", /exec-path/],
    ["git -c core.hooksPath=/dev/null status", /hooksPath/],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git status", /hooksPath/],
    ["git -c core.fsmonitor='git commit -am x' status", /config override/],
    ["GIT_EDITOR='git push' git log", /variable GIT_EDITOR/],
    ["git grep -O\"sh -c 'git push'\" foo", /grep -O/],
    ["git grep -O\"git commit -am x\" foo", /grep -O/],
    ["git grep -iO\"git push\" foo", /grep -O/],
    ["git grep \"-Ogit commit -am x\" foo", /grep -O/],
    ["git grep --op=\"git commit -am x\" foo", /grep -O/],
    ["git grep --open-files=\"git push origin main\" foo", /grep -O/],
    ["git grep --open-files-in-pager=\"git push\" foo", /grep -O/],
    ["git -c remote.origin.uploadpack='sh -c x' fetch origin", /runs a program/],
    ["git -c remote.origin.fetch=+refs/heads/*:refs/heads/* fetch --prune origin", /fetches into local branches/],
    ["git -c core.fsmonitor=x status", /may not override the git setting core\.fsmonitor: only display settings/],
    ["git --config-env=core.fsmonitor=FOO status", /may not override the git setting core\.fsmonitor/],
    ["git --config-env=color.ui=FOO status", /may not use --config-env/],
    ["GIT_SSH_COMMAND='sh x.sh' git fetch origin", /point GIT_SSH_COMMAND at a program/],
    ["git diff --textconv", /--textconv/],
    ["git fetch origin main:main", /the refspec main:main can move local branches; the read-only forms are git fetch \[origin \[<branch>\]\]/],
    ["git fetch -P origin", /git fetch -P is not a read-only form/],
    ["git update-ref -d refs/heads/x", /git update-ref is not in the wf read-only git list/],
    ["git filter-branch", /not in the wf read-only git list/],
    ["git mv a b", /not in the wf read-only git list/],
    ["git \"$SUB\"", /variable/]
  ];
  for (const [text, reason] of table) {
    test(`${text} is refused: ${reason.source}`, () => {
      const verdict = levelOf(text);
      assert.equal(verdict.level, "write");
      assert.match(verdict.reason, reason);
    });
  }
});

describe("classifyGit: git grep takes its -O pager attached only", () => {
  test("a value after a spaced -O is the search pattern, not a pager", () => {
    assert.deepEqual(levelOf("git grep -O \"git commit -am x\" foo"), { level: "read", reason: null });
  });

  test("a value-taking short option ends the flag cluster before an O", () => {
    assert.deepEqual(levelOf("git grep -e\"Ogit push\" foo"), { level: "read", reason: null });
  });

  test("arguments after -- are paths", () => {
    assert.deepEqual(levelOf("git grep foo -- \"-Ogit push\""), { level: "read", reason: null });
  });
});

describe("classifyGh", () => {
  const reads = [
    "gh",
    "gh --version",
    "gh pr view 12",
    "gh pr view 12 --json title,body",
    "gh pr list --state open",
    "gh pr status",
    "gh pr diff 12",
    "gh pr checks 12",
    "gh issue view 3",
    "gh issue list",
    "gh repo view owner/repo",
    "gh run list",
    "gh run view 99 --log",
    "gh run watch 99",
    "gh release list",
    "gh search issues wf",
    "gh status",
    "gh auth status",
    "gh -R owner/repo pr view 1",
    "gh pr create --help",
    "gh api repos/o/r/pulls",
    "gh api -X GET repos/o/r/issues -f state=open",
    "gh api --method=GET repos/o/r",
    "gh api graphql -f query='query { viewer { login } }'"
  ];
  for (const text of reads) {
    test(`${text} is read-only`, () => {
      assert.equal(ghLevel(text).level, "read");
    });
  }

  const plainWrites = [
    "gh pr create --fill",
    "gh -R o/r pr create --title x --body y",
    "gh pr merge 12",
    "gh pr merge 3 --merge --delete-branch",
    "gh pr close 12",
    "gh pr comment 12 -b x",
    "gh pr review 12 --approve",
    "gh pr checkout 12",
    "gh issue create -t x",
    "gh release create v1",
    "gh repo delete o/r",
    "gh repo clone o/r",
    "gh workflow run ci.yml",
    "gh auth login"
  ];
  for (const text of plainWrites) {
    test(`${text} is a write`, () => {
      assert.deepEqual(ghLevel(text), { level: "write", reason: null });
    });
  }

  const writes = [
    ["gh api -X POST repos/o/r/issues", /POST/],
    ["gh api -XDELETE repos/o/r", /DELETE/],
    ["gh api -X DELETE repos/o/r/git/refs/heads/old", /^gh api DELETE writes to GitHub$/],
    ["gh api repos/o/r/issues -f title=x", /fields/],
    ["gh api repos/o/r/issues --input body.json", /fields/],
    ["gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }'", /mutation/]
  ];
  for (const [text, reason] of writes) {
    test(`${text} is a write: ${reason.source}`, () => {
      const verdict = ghLevel(text);
      assert.equal(verdict.level, "write");
      assert.match(verdict.reason, reason);
    });
  }
});
