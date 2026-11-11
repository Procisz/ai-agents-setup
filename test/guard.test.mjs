import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_AGENT, decide, evaluate, unrestricted } from "../hooks/guard.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUARD = path.join(REPO, "hooks", "guard.mjs");
const WORKER_RULE = "only wf:git runs git and gh writes; leave the changes in the working tree for the orchestrator";
const MAIN_RULE = "only wf:git runs git and gh writes; delegate them to wf:git only when it is installed and the approved summary asks for git work, else leave the work uncommitted and list the commands in the report";
const WHO = [
  ["worker", (command) => evaluate({ command, subagent: true, agentType: "wf:coder-t1" })],
  ["orchestrator", (command) => evaluate({ command, subagent: false, agentType: "wf:orchestrator" })],
  ["wf:git", (command) => evaluate({ command, subagent: true, agentType: "wf:git" })]
];

let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-guard-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function project(name, allowGit = null) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  if (allowGit !== null) {
    fs.mkdirSync(path.join(root, ".work", "20261028-1000-a"), { recursive: true });
    fs.writeFileSync(path.join(root, ".work", "20261028-1000-a", "allow-git"), allowGit);
  }
  return root;
}

function runHook(input, { env = {}, raw } = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: raw ?? JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, "config"), ...env },
    timeout: 10000
  });
}

describe("guard matrix: commands x worker, orchestrator or wf:git", () => {
  const A = true;
  const R = false;
  const matrix = [
    ["git status", A],
    ["git log --oneline | head -20", A],
    ["git diff --stat && git status --porcelain", A],
    ["git fetch origin", A],
    ["git add -A", R],
    ["git commit -m x", R],
    ["git add src/a.js && git commit -m 'wf: slugify'", R],
    ["git commit -m \"$(cat <<'EOF'\nAdd slugify\n\nCo-Authored-By: x\nEOF\n)\"", R],
    ["git push origin m8", R],
    ["git add -A && git commit -m x && git push", R],
    ["git push --force origin main", R],
    ["git push origin +main", R],
    ["git push --tags", R],
    ["git commit --amend --no-edit", R],
    ["git commit --no-verify -m x", R],
    ["git reset --hard HEAD~1", R],
    ["git checkout -b feature", R],
    ["git stash", R],
    ["git tag v1.0", R],
    ["git branch -D old", R],
    ["git branch feature/x", R],
    ["git branch -a", A],
    ["gh pr view 3", A],
    ["gh pr create --fill", R],
    ["gh pr merge 3", R],
    ["bash -c 'git commit -m x'", R],
    ["sh -c \"git push origin main\"", R],
    ["timeout 30 git commit -am x", R],
    ["sudo -u me git push", R],
    ["cd sub && git -C .. push", R],
    ["git ls-files -m | xargs git add", R],
    ["find . -name '*.js' -exec git add {} \\;", R],
    ["env GIT_PAGER=cat git log", A],
    ["G=git; $G commit -m x", R],
    ["G=git; $G status", A],
    ["$RUNNER test", A],
    ["echo 'git push' | bash", R],
    ["bash <<'SH'\ngit commit -m x\nSH", R],
    ["python3 -c \"import os; os.system('git push')\"", R],
    ["cmd //c \"git commit -m x\"", R],
    ["git -c core.hooksPath=/dev/null commit -m x", R],
    ["echo 'git push'", A],
    ["grep -rn \"git commit\" docs", A],
    ["node --test test/git.test.mjs", A],
    ["node --test && git add -A && git commit -m x", R],
    ["printf 'import os\\nos.system(\"git push\")' | python3", R],
    ["python3 - <<'PY'\nimport subprocess\nsubprocess.run(['git', 'commit', '-m', 'x'])\nPY", R],
    ["npm test 2>&1 | tail -5 && git status", A],
    ["bash scripts/check.sh --commit", A],
    ["ls -la", A],
    ["git fetch", A],
    ["git fetch origin main", A],
    ["git fetch --prune origin", A],
    ["git fetch --all --tags --quiet", A],
    ["git fetch --depth=1 origin main", A],
    ["git fetch git@github.com:me/repo.git main", A],
    ["git fetch --upload-pack='git commit -qam x; git-upload-pack' .", R],
    ["git fetch --upl='touch /tmp/x; git-upload-pack' .", R],
    ["git fetch --update-head-ok . +abc123:refs/heads/main", R],
    ["git fetch -u . +x:work", R],
    ["git fetch . +HEAD~1:main", R],
    ["git fetch . +HEAD~1:refs/heads/other", R],
    ["git fetch origin main:main", R],
    ["git fetch -f origin main:main", R],
    ["git fetch origin +main:main", R],
    ["git fetch --prune origin '+refs/heads/*:refs/heads/*'", R],
    ["git fetch --refmap='+refs/heads/*:refs/heads/x-*' origin main", R],
    ["git fetch -P origin", R],
    ["git fetch --prune-tags origin", R],
    ["git fetch --set-upstream origin main", R],
    ["git -c remote.origin.fetch=+refs/heads/*:refs/heads/* fetch --prune origin", R],
    ["git -c remote.origin.uploadpack='sh -c x' fetch origin", R],
    ["echo -D topic | xargs git branch", R],
    ["echo -d v1 | xargs git tag", R],
    ["echo core.hooksPath /dev/null | xargs git config", R],
    ["echo remove origin | xargs git remote", R],
    ["echo push | xargs git", R],
    ["echo commit --allow-empty -m sneaky | xargs git", R],
    ["echo --amend | xargs git commit", R],
    ["echo --force | xargs git push", R],
    ["xargs git < cmds.txt", R],
    ["xargs -a cmds.txt git", R],
    ["git ls-files | xargs git status", A],
    ["git diff --name-only | xargs git log --oneline", A],
    ["echo 3 | xargs gh pr view", A],
    ["echo -X POST | xargs gh api repos/o/r/issues", R],
    ["find . -name x -exec git branch -D {} \\;", R],
    ["find . -name '*.js' -exec git add {} +", R],
    ["env -S 'git commit -m x'", R],
    ["env -S'git push origin main'", R],
    ["env --split-string='git commit -m x'", R],
    ["env --split-string 'git commit -m x'", R],
    ["arch -arm64 git commit -m x", R],
    ["arch git commit -m x", R],
    ["caffeinate -i git commit -m x", R],
    ["caffeinate -t 60 git push", R],
    ["setsid -f git commit -m x", R],
    ["unbuffer -p git commit -m x", R],
    ["chronic -e git commit -m x", R],
    ["rlwrap git commit -m x", R],
    ["xcrun git commit -m x", R],
    ["${G:-git} commit -m x", R],
    ["function f { git commit -m x; }; f", R],
    ["mywrapper --flag git push origin main", R],
    ["echo git push done", A],
    ["brew install git gh", A],
    ["git -c core.fsmonitor='g\"i\"t stash' status", R],
    ["git -c 'diff.external=g\"i\"t stash' diff --ext-diff", R],
    ["GIT_EXTERNAL_DIFF='g\"i\"t stash' git diff", R],
    ["GIT_SSH_COMMAND='sh x.sh' git fetch origin", R],
    ["git --config-env=core.fsmonitor=FOO status", R],
    ["git diff --textconv", R],
    ["git -c color.ui=always log --oneline", A],
    ["git -c core.quotepath=off status", A],
    ["git -c core.pager=cat log", A],
    ["GIT_PAGER=less git log", A],
    ["GIT_EDITOR=true git log", A],
    ["node --test --test-name-pattern='git commit' test/", A],
    ["node --test --test-name-pattern 'refuses git push' test/", A],
    ["python3 -m pytest -k 'git and push'", A],
    ["node -e \"require('child_process').execFileSync(process.argv[1], process.argv.slice(2))\" git push", R],
    ["gh api graphql -f query='query { viewer { login } }'", A],
    ["gh api graphql -f query='query($owner: String!) { repository(owner: $owner, name: \"x\") { id } }' -f owner=me", A],
    ["gh api graphql -F query=@m.graphql", R],
    ["gh api graphql --input body.json", R],
    ["echo '{}' | gh api graphql --input -", R],
    ["gh api graphql -f query=\"$Q\"", R],
    ["gh api graphql -f query=\"$(cat m.graphql)\"", R],
    ["sh ./x.sh", A],
    ["npm run commit", A],
    ["export GIT_PAGER=\"git commit -am x\"; git log", R],
    ["export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=\"git commit -qam x;:\"; git status", R],
    ["export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=./mark.sh; git status", R],
    ["export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; git status", R],
    ["declare -x GIT_PAGER=\"git push\"; git log", R],
    ["typeset -x GIT_PAGER=\"git push\" && git log", R],
    ["GIT_PAGER=./x.sh; export GIT_PAGER; git log", R],
    ["export GIT_EXTERNAL_DIFF=./x.sh; git diff", R],
    ["export GIT_SSH_COMMAND=./x.sh; git fetch origin", R],
    ["export GIT_PAGER=\"git push\"; bash -c 'git log'", R],
    ["export FOO=1; git status", A],
    ["export GIT_PAGER=less; git log", A],
    ["git grep -O\"git commit -am x\" foo", R],
    ["git grep -iO\"git push\" foo", R],
    ["git grep \"-Ogit commit -am x\" foo", R],
    ["git grep --op=\"git commit -am x\" foo", R],
    ["git grep --open-files=\"git push origin main\" foo", R],
    ["git grep -O foo", A],
    ["bash -c '\"$@\"' _ git commit -am x", R],
    ["sh -c '$*' sh git push", R],
    ["zsh -c '\"$@\"' _ gh pr merge 1", R],
    ["bash -c '\"$@\"' _ git status", A],
    ["echo git push | xargs bash -c '\"$@\"' _", R],
    ["echo '\"$@\"' | bash -s git commit -am x", R],
    ["echo 'git status' | bash -s foo", A]
  ];
  for (const [command, readOnly] of matrix) {
    for (const [who, run] of WHO) {
      const expected = who === "wf:git" ? true : readOnly;
      test(`${who}: ${expected ? "allows" : "refuses"} ${JSON.stringify(command)}`, () => {
        const result = run(command);
        assert.equal(result.allow, expected, result.message ?? "allowed");
        if (!expected) assert.match(result.message, /^wf guard: .+ may not run ".+": .+\.$/);
      });
    }
  }
});

describe("guard messages", () => {
  test("a worker refusal names the agent type, the command and the wf:git rule", () => {
    assert.equal(
      evaluate({ command: "git commit -m x", subagent: true, agentType: "wf:coder-t1" }).message,
      `wf guard: subagent wf:coder-t1 may not run "git commit -m x": ${WORKER_RULE}.`
    );
  });

  test("a worker gh write gets the same rule", () => {
    assert.equal(evaluate({ command: "gh pr create --fill", subagent: true, agentType: "wf:docs-t1" }).message, `wf guard: subagent wf:docs-t1 may not run "gh pr create --fill": ${WORKER_RULE}.`);
  });

  test("a subagent without an agent type is named unknown", () => {
    assert.match(evaluate({ command: "git push", subagent: true }).message, /^wf guard: subagent unknown may not run/);
  });

  test("the orchestrator is told to delegate git writes to wf:git, and what to do when no git agent is installed", () => {
    assert.equal(evaluate({ command: "git commit -m x" }).message, `wf guard: the orchestrator may not run "git commit -m x": ${MAIN_RULE}.`);
    assert.equal(evaluate({ command: "git push -u origin feature/x", agentType: "wf:orchestrator" }).message, `wf guard: the orchestrator may not run "git push -u origin feature/x": ${MAIN_RULE}.`);
    assert.equal(evaluate({ command: "gh pr create --fill" }).message, `wf guard: the orchestrator may not run "gh pr create --fill": ${MAIN_RULE}.`);
  });

  test("a git command outside the read-only list says so", () => {
    assert.equal(
      evaluate({ command: "git reflog -5", subagent: true, agentType: "wf:coder-t1" }).message,
      "wf guard: subagent wf:coder-t1 may not run \"git reflog -5\": git reflog is not in the wf read-only git list."
    );
  });

  test("a config override names the setting and the allowed kind, for the orchestrator too", () => {
    const expected = /read-only git may not override the git setting core\.fsmonitor: only display settings such as color\.\* or core\.quotepath\.$/;
    assert.match(evaluate({ command: "git -c core.fsmonitor=x status", subagent: true, agentType: "wf:coder-t1" }).message, expected);
    assert.match(evaluate({ command: "git -c core.fsmonitor=x status" }).message, expected);
  });

  test("a fetch refspec is refused with the read-only fetch forms", () => {
    assert.match(evaluate({ command: "git fetch origin main:main" }).message, /the refspec main:main can move local branches; the read-only forms are git fetch \[origin \[<branch>\]\]/);
  });

  test("the first refused invocation of a compound command is reported", () => {
    assert.match(evaluate({ command: "git status && git commit -m x && git push -f" }).message, /"git commit -m x": only wf:git/);
  });

  test("an opaque runner names the runner and shows its text", () => {
    assert.equal(evaluate({ command: "echo 'git push' | bash" }).message, "wf guard: the orchestrator may not run \"echo 'git push' | bash\": a git or gh write inside bash cannot be checked.");
  });

  test("a variable exported by an earlier statement is refused with the reason of its inline twin", () => {
    const pairs = [
      ["export GIT_PAGER=\"git commit -am x\"; git log", "GIT_PAGER=\"git commit -am x\" git log"],
      ["export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=\"git commit -am x\"; git status", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=\"git commit -am x\" git status"],
      ["export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; git status", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git status"],
      ["declare -x GIT_PAGER=\"git push\"; git log", "GIT_PAGER=\"git push\" git log"],
      ["typeset -x GIT_PAGER=\"git push\" && git log", "GIT_PAGER=\"git push\" git log"],
      ["GIT_PAGER=./x.sh; export GIT_PAGER; git log", "GIT_PAGER=./x.sh git log"],
      ["export GIT_EXTERNAL_DIFF=./x.sh; git diff", "GIT_EXTERNAL_DIFF=./x.sh git diff"],
      ["export GIT_SSH_COMMAND=./x.sh; git fetch origin", "GIT_SSH_COMMAND=./x.sh git fetch origin"]
    ];
    const reasonOf = (command) => {
      const result = evaluate({ command, subagent: true, agentType: "wf:coder-t1" });
      assert.equal(result.allow, false, command);
      return result.message.slice(result.message.lastIndexOf("\": ") + 3);
    };
    for (const [exported, inline] of pairs) assert.equal(reasonOf(exported), reasonOf(inline), exported);
  });

  test("a positional-parameter script names its shell and shows the whole command", () => {
    assert.equal(evaluate({ command: "bash -c '\"$@\"' _ git commit -am x", subagent: true, agentType: "wf:coder-t1" }).message, "wf guard: subagent wf:coder-t1 may not run \"bash -c '\"$@\"' _ git commit -am x\": a git or gh write inside bash cannot be checked.");
  });

  test("a long command is clipped to 200 characters in the message", () => {
    const message = evaluate({ command: `git commit -m '${"x".repeat(400)}'`, subagent: true, agentType: "wf:coder-t1" }).message;
    const shown = /"(.*)"/.exec(message)[1];
    assert.equal(shown.length, 200);
    assert.ok(shown.endsWith("..."));
  });
});

describe("wf:git", () => {
  test("is the only unrestricted agent type, matched exactly", () => {
    assert.equal(GIT_AGENT, "wf:git");
    assert.equal(unrestricted("wf:git"), true);
    for (const other of ["", "git", "wf:git-t1", "wf:gitx", "WF:GIT", "wf:orchestrator", "wf:coder-t3", "other:git"]) assert.equal(unrestricted(other), false, other);
  });

  test("runs every git and gh command, the ones refused to everyone else included", () => {
    for (const command of ["git push --force origin main", "git commit --amend --no-edit", "git reset --hard HEAD~1", "git tag v1.0", "git push --tags", "gh pr merge 3 --squash", "gh api -X POST repos/o/r/issues", "echo 'git push' | bash", "G=git; $G commit -m x"]) {
      assert.equal(evaluate({ command, subagent: true, agentType: "wf:git" }).allow, true, command);
    }
  });

  const NO_LIMIT_COMMANDS = [
    "git branch -D old",
    "git push origin --delete old",
    "git push origin :old",
    "git push origin HEAD:main",
    "git push --force-with-lease origin feature/x",
    "git rebase main",
    "git reset --hard origin/main",
    "git tag -a v1.0 -m x && git push origin v1.0",
    "git merge --no-ff feature/x",
    "gh pr merge 3 --merge --delete-branch",
    "gh api -X DELETE repos/o/r/git/refs/heads/old",
    "git branch --merged main | xargs git branch -d"
  ];

  test("runs branch deletion, force pushes, pushes to main, rebase, reset, tags and merges without limit", () => {
    for (const command of NO_LIMIT_COMMANDS) {
      assert.equal(evaluate({ command, subagent: true, agentType: "wf:git" }).allow, true, command);
    }
  });

  test("the same commands are refused to a worker subagent and to the orchestrator", () => {
    for (const command of NO_LIMIT_COMMANDS) {
      for (const [who, verdict] of [
        ["wf:coder-t3", evaluate({ command, subagent: true, agentType: "wf:coder-t3" })],
        ["orchestrator", evaluate({ command, subagent: false, agentType: "wf:orchestrator" })]
      ]) {
        assert.equal(verdict.allow, false, `${who}: ${command}`);
        assert.match(verdict.message, /^wf guard: .+ may not run ".+": .+\.$/, `${who}: ${command}`);
      }
    }
  });

  test("is not parsed at all, so a parse failure cannot refuse it", () => {
    const broken = () => {
      throw new Error("parser exploded");
    };
    assert.equal(evaluate({ command: "git push origin feature/x", subagent: true, agentType: "wf:git", parse: broken }).allow, true);
  });
});

describe("guard parse failures", () => {
  const broken = () => {
    throw new Error("parser exploded");
  };

  test("a parse failure refuses when the text has git or gh followed by a write-looking word", () => {
    for (const command of ["git push origin main", "gh pr merge 3", "X && git commit -m y"]) {
      const result = evaluate({ command, subagent: true, agentType: "wf:coder-t1", parse: broken });
      assert.equal(result.allow, false, command);
      assert.match(result.message, /could not be parsed and looks like a git or gh write\.$/, command);
    }
  });

  test("a parse failure allows anything else", () => {
    for (const command of ["git status", "ls -la", "echo digit commit"]) {
      assert.equal(evaluate({ command, subagent: true, parse: broken }).allow, true, command);
    }
  });
});

describe("decide", () => {
  test("allows tools other than Bash and inputs without a command", () => {
    assert.equal(decide({ tool_name: "Read", tool_input: { command: "git push" } }).allow, true);
    assert.equal(decide({ tool_name: "Bash", tool_input: {} }).allow, true);
    assert.equal(decide(null).allow, true);
  });

  test("Monitor and PowerShell commands are guarded like Bash", () => {
    const root = project("decide-shells");
    for (const tool of ["Monitor", "PowerShell"]) {
      const commit = decide({ tool_name: tool, tool_input: { command: "git commit -m x" }, cwd: root });
      assert.equal(commit.allow, false, `${tool} orchestrator commit`);
      assert.match(commit.message, /delegate them to wf:git only when it is installed/);
      const worker = decide({ tool_name: tool, tool_input: { command: "git commit -m x" }, cwd: root, agent_id: "a1", agent_type: "wf:coder-t1" });
      assert.equal(worker.allow, false, `${tool} subagent commit`);
      assert.equal(decide({ tool_name: tool, tool_input: { command: "git status" }, cwd: root, agent_id: "a1" }).allow, true, `${tool} read`);
      assert.equal(decide({ tool_name: tool, tool_input: { command: "git push origin feature/x" }, cwd: root, agent_id: "a2", agent_type: "wf:git" }).allow, true, `${tool} wf:git push`);
    }
  });

  test("an agent_id makes the caller a subagent", () => {
    const result = decide({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: project("decide-sub"), agent_id: "a1", agent_type: "wf:coder-t2" });
    assert.equal(result.allow, false);
    assert.match(result.message, /subagent wf:coder-t2/);
  });

  test("a retired allow-git file no longer lets the orchestrator commit or push", () => {
    const root = project("decide-retired", "push\n");
    for (const command of ["git add -A", "git commit -m x", "git push origin m8", "gh pr create --fill"]) {
      const result = decide({ tool_name: "Bash", tool_input: { command }, cwd: root, agent_type: "wf:orchestrator" });
      assert.equal(result.allow, false, command);
      assert.match(result.message, /^wf guard: the orchestrator may not run/, command);
    }
  });

  test("the wf:git subagent pushes and opens a pull request", () => {
    const root = project("decide-git");
    for (const command of ["git switch -c feature/x", "git add -- src/a.js && git commit -m 'Add a'", "git push -u origin feature/x", "gh pr create --title x --body y"]) {
      assert.equal(decide({ tool_name: "Bash", tool_input: { command }, cwd: root, agent_id: "g1", agent_type: "wf:git" }).allow, true, command);
    }
  });
});

describe("guard hook process", () => {
  test("refuses a subagent git commit with exit 2 and the message on stderr", () => {
    const result = runHook({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit --allow-empty -m test" }, cwd: tmp, agent_id: "a9", agent_type: "wf:coder-t1" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `wf guard: subagent wf:coder-t1 may not run "git commit --allow-empty -m test": ${WORKER_RULE}.\n`);
  });

  test("allows git status with exit 0 and no output", () => {
    const result = runHook({ session_id: "s1", tool_name: "Bash", tool_input: { command: "git status" }, cwd: tmp, agent_id: "a9", agent_type: "wf:coder-t1" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });

  test("refuses an exported pager that runs a git write with exit 2, like its inline form", () => {
    for (const command of ["export GIT_PAGER=\"git commit -am x\"; git log", "GIT_PAGER=\"git commit -am x\" git log"]) {
      const result = runHook({ session_id: "s1", tool_name: "Bash", tool_input: { command }, cwd: tmp, agent_id: "a9", agent_type: "wf:coder-t1" });
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /the variable GIT_PAGER runs a git write\.\n$/, command);
    }
  });

  test("allows a wf:git push with exit 0", () => {
    const result = runHook({ session_id: "s1", tool_name: "Bash", tool_input: { command: "git push -u origin feature/x" }, cwd: project("hook-git"), agent_id: "g9", agent_type: "wf:git" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  });

  test("allows a wf:git force push to main and a remote branch deletion with exit 0 and refuses them to a worker with exit 2", () => {
    for (const command of ["git push --force origin main", "git push origin --delete old"]) {
      const allowed = runHook({ session_id: "s1", tool_name: "Bash", tool_input: { command }, cwd: project("hook-git-force"), agent_id: "g9", agent_type: "wf:git" });
      assert.equal(allowed.status, 0, `${command}: ${allowed.stderr}`);
      assert.equal(allowed.stderr, "", command);
      const refused = runHook({ session_id: "s1", tool_name: "Bash", tool_input: { command }, cwd: project("hook-git-force"), agent_id: "a9", agent_type: "wf:coder-t1" });
      assert.equal(refused.status, 2, command);
      assert.match(refused.stderr, /^wf guard: subagent wf:coder-t1 may not run /, command);
    }
  });

  test("refuses the orchestrator push with exit 2, even with an allow-git file", () => {
    const result = runHook({ session_id: "s1", tool_name: "Bash", tool_input: { command: "git push origin m8" }, cwd: project("hook-push", "push"), agent_type: "wf:orchestrator" });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, `wf guard: the orchestrator may not run "git push origin m8": ${MAIN_RULE}.\n`);
  });

  test("an internal error allows and appends one line to hook-errors.log", () => {
    const config = path.join(tmp, "config-error");
    const result = runHook(null, { raw: "{not json", env: { CLAUDE_CONFIG_DIR: config } });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const log = fs.readFileSync(path.join(config, "ai-agents-setup", "state", "hook-errors.log"), "utf8");
    assert.equal(log.trim().split("\n").length, 1);
    assert.match(log, /guard: SyntaxError/);
  });
});
