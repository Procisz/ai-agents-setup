# ai-agents-setup: wf v2

wf is my personal Claude Code workflow: type `wf` in a project, say what you want, approve one short summary, and an orchestrator on Sonnet hands the work to cheaper agents and comes back with a short report.
It sizes every task by difficulty and risk (tiers T0 to T5), installs only the tiers, agents, models and skills you pick, loads the chosen skills into each agent, hands work over before a context window fills up, gives each agent a prompt cache that fits its role (1 hour for coder and debugger, 5 minutes for the others) and keeps the main thread and the 1 hour agents warm while you are away (up to about 6 idle hours), the 5 minute agents for 30 minutes after their last work. It commits, pushes or opens a pull request only when you ask, through its own git agent, which does exactly the git work your approved summary names and nothing else.
Everything lives in a plugin that only the `wf` launcher loads, so a plain `claude` session stays exactly as it was.

A visual version of this page, with a Copy button on every command: open `docs/guide/wf-guide.html` from your clone in a browser.

## Requirements

- Node 22 or newer (`node --version`; on macOS `brew install node`).
- Claude Code 2.1.312 or newer from the native installer (`claude --version`; on macOS and Linux `curl -fsSL https://claude.ai/install.sh | bash`; older: `claude update`).
- git and the GitHub CLI `gh`, to clone this private repository (and in your projects: git for the git phase, `gh`, signed in, for pull requests).
- macOS is the daily system and the one checked live. Linux (CI runs the tests on Ubuntu) and native Windows (covered by the offline tests only) are supported too; see Troubleshooting.

## Install

1. Sign in to GitHub (the repository is private), go to any folder where you keep projects, and clone:

```
gh auth login
```

```
gh repo clone Procisz/ai-agents-setup
```

```
cd ai-agents-setup
```

This is your clone folder. It can be anywhere: every `node wf.mjs` command in this README runs from it, whatever its path. Whenever you are not sure you are there, check (expected: `wf.mjs`; "No such file" means another folder, so `cd` to your clone first):

```
ls wf.mjs
```

2. Install:

```
node wf.mjs install
```

What you see in a terminal, in order: a header box (`wf 2.1.1 · installer`), your config and launcher folders, `✔ Claude Code 2.1.312` and `✔ Lint: 0 errors, 0 warnings`, then five steps, one question each: tiers, agents, models, skills and a summary (see [The five install steps](#the-five-install-steps)). To install everything with the recommended skills, press enter on every list and once more on Install (twelve presses on a first install: tiers, agents, models, one skills list for each of the eight roles, then Install). Then `✔ Applied 103 changes. Backup: <stamp> (node wf.mjs restore puts it back).` (103 on a fresh macOS or Linux install with everything ticked, 107 on Windows), `✔ verify: claude plugin validate passed`, `✔ verify: 103 files match.` and `Next: run wf in a project folder.` With a node from nvm or another version manager, a `⚠ The hooks will run ...` warning comes right after the Lint line (see Troubleshooting).

With `--yes`, or without a terminal, nothing is asked: instead of the five steps you get one line each for `Tiers:`, `Agents:`, `Models:` and `Skills:` and a line for each missing tier or agent and each unticked model that an installed agent was set to, then the plan and the result. Without a terminal (a pipe, CI) the output is plain text with no box, icons or wrapping, and no colors unless `FORCE_COLOR` is set: `wf install: <config folder> (launcher <folder>)`, `Claude Code 2.1.312`, `Lint: ...`, `Tiers: T1, T2, T3, T4, T5` and the other answer lines, a `note:` line for each missing tier or agent and each unticked model whose agents run on a stand-in, `Plan: 103 create, 0 update, 0 remove, 0 unchanged` with the folders, `Applied 97 changes. ...`, the verify lines and `Next: run wf in a project folder.`

3. If install printed `<folder> is not on PATH. Add it: echo '...' >> ~/.zshrc, then open a new terminal.`, run the `echo ... >> ~/.zshrc` command from that line (from `echo` up to the file name), then open a new terminal and check (expected: a path ending in `.local/bin/wf`):

```
command -v wf
```

4. From your clone folder, check the install (expected last line: `wf doctor: all good.`, or `all good (1 warning).` with the `warn` line above it):

```
node wf.mjs doctor
```

### The five install steps

Every step starts with `Step n of 5`, an icon and a title, then two to four lines on what you decide: what the step controls, what unticking does and what the default is. Then comes the list. Every list starts from your saved answer of the last install, or the first time from the defaults: every tier, agent and model ticked, and each role's recommended skills. Under the item at the cursor a `↳` line says what unticking it does. After enter the list makes way for one result line, such as `✔ Tiers: T1, T2, T3, T4 (T5 runs as T4)`.

| Step | What you decide | Default | When you untick something |
|---|---|---|---|
| 1 📊 Tiers | which task sizes get their own agents: T1 small, T2 medium, T3 large, T4 major, T5 critical (how a task gets its tier: [below](#how-a-task-gets-its-tier)). T0 (questions and tiny edits) needs no agents and is always there. | all five | At least one stays ticked. A task of a missing tier runs as the nearest installed tier, the higher one on a tie. |
| 2 🤖 Agents | which workers are installed: planner, docs, coder, tester, reviewer, debugger and git. Each role has one agent per installed tier, except git: one `wf:git` for every tier. Only the roles your tiers use are listed. The orchestrator is the main thread and always installed. | all of them | The coder is locked (`needed by every tier`). The work of a missing agent moves to a coder (see [below](#what-a-missing-tier-agent-or-model-means)); without the debugger, a repeated failure gets one more coder round, then the report; without the git agent, the work stays uncommitted and the report lists the git commands. |
| 3 🧠 Models | which models wf may use: Opus 5.5, Sonnet 5.5 and Haiku 5.5, strongest first. Each shows how many installed agents are set to it. | all three | At least one stays ticked. An agent (the orchestrator too) whose model is unticked runs on the nearest ticked model, the stronger one on a tie, with the same effort. |
| 4 🧩 Skills | which skills are built into each installed agent's prompt: one list per role, the orchestrator first. | each role's recommended skills | Required skills are locked (`required`). An unticked skill stays in the library, where agents read it when a task needs it. |
| 5 📋 Summary | whether to write it all: a table of every agent with its tier, model and effort, one line per missing tier or agent and per unticked model that an installed agent was set to, with what happens instead, the skill counts and the file plan (with the v1 migration block, if any). | Install | Change choices starts again at step 1 with your current answers ticked. Cancel stops with nothing written. |

Keys: up and down move, space toggles, `a` toggles all, enter confirms the list, esc cancels the whole install (`Cancelled: nothing was written.`). Locked items are dimmed, with the reason. The tier and model lists need at least one tick: enter with none shows `pick at least 1` and waits. A list taller than the terminal shows the part around the cursor, with `↑ n more above` and `↓ n more below` lines, and scrolls as you move. In a narrow terminal the key line gets shorter (`space toggle · a all · enter ok · esc cancel`). A list while you answer, here with T5 unticked:

```text
  ? Which tiers should wf install?
    ◉ T1  mechanical or fully specified, low risk
    ◉ T2  new behavior or open choices in one area
    ◉ T3  cross-cutting, public interfaces or new ground
    ◉ T4  risky changes across modules or stored formats
  ❯ ◯ T5  risky domains, irreversible changes or extra care
    ↳ T5 is skipped: a T5-sized task runs as T4
    ↑/↓ move · space toggle · a all · enter confirm · esc cancel
```

In the agents list, the git agent at the cursor:

```text
  ? Which agents should wf install?
    ◉ planner   writes the execution plan of every task
    ◉ docs      updates the project docs a task affects
    ◉ coder     needed by every tier
    ◉ tester    writes and runs the tests after the code
    ◉ reviewer  reviews the change when the user asks for a review
    ◉ debugger  fixes a failure that came back for the same reason
  ❯ ◉ git       branches, commits, pushes and opens pull requests when the sum…
    ↳ Untick the git agent: the work stays uncommitted and the report lists the
      git commands
    ↑/↓ move · space toggle · a all · enter confirm · esc cancel
```

The summary ends with one single-choice question, `Install now?`:

- **Install**: writes the files, after backing up every file it changes. This is the only confirmation: no `Apply N changes?` question follows.
- **Change choices**: back to step 1, with the answers you just gave ticked.
- **Cancel** (or esc): `Cancelled: nothing was written.`

Only enter chooses here: space, which ticks items in the lists before, does nothing on this question but show `press enter to choose`.

The box, the icons and the colors appear only in a terminal: cyan for the cursor and the titles, green for ticks, yellow for warnings, dim for hints and locked items. `NO_COLOR` turns the colors off. `FORCE_COLOR` forces the colors, also in a pipe, but never the box, the icons or the wrapping. In a Windows console outside Windows Terminal the icons fall back to ASCII (`[x]`, `[ ]`, `>`, `+`, `!`). With `TERM=dumb` they fall back to ASCII too, and the lists become numbered questions that need no cursor keys: type the numbers to toggle and press enter to accept.

A sample run, shortened (`...` marks cut lines): a first install with T5, the reviewer and Opus 5.5 unticked, as an 80 column terminal looks after Install.

```text
  ╭───────────────────────────────────────────────────────────────────────╮
  │                                                                       │
  │  wf 2.1.1 · installer                                                 │
  │  Sets up wf for Claude Code: agents, skills, hooks and the launcher.  │
  │                                                                       │
  ╰───────────────────────────────────────────────────────────────────────╯

  Config    /Users/you/.claude
  Launcher  /Users/you/.local/bin

  ✔ Claude Code 2.1.312
  ✔ Lint: 0 errors, 0 warnings

  Step 1 of 5  📊 Tiers
  A tier is a task size: T1 small, T2 medium, T3 large, T4 major and T5 critical.
  Untick one and its tasks run as the nearest tier left, the higher on a tie.
  Default: all of them. T0, questions and tiny edits, needs no agents.

  ✔ Tiers: T1, T2, T3, T4 (T5 runs as T4)

  Step 2 of 5  🤖 Agents
  ...
  ✔ Agents: planner, docs, coder, tester, debugger, git (without reviewer)

  Step 3 of 5  🧠 Models
  ...
  ✔ Models: Sonnet 5.5, Haiku 5.5 (1 agent on a stand-in)

  Step 4 of 5  🧩 Skills
  ...
  ✔ orchestrator: 5 skills
  ✔ planner: 3 skills
  ...
  ✔ git: 2 skills

  Step 5 of 5  📋 Summary
  Check the setup below. Nothing is written until you choose Install,
  and every file it changes is backed up first.

    Role          Tier  Agent            Model        Effort
    orchestrator  main  wf:orchestrator  Sonnet 5.5   medium
    planner       T1    wf:planner-t1    Haiku 5.5    medium
                  T2    wf:planner-t2    Sonnet 5.5   low
                  T3    wf:planner-t3    Sonnet 5.5   medium
                  T4    wf:planner-t4    Sonnet 5.5   high
    docs          T1    wf:docs-t1       Haiku 5.5    low
                  T2    wf:docs-t2       Haiku 5.5    medium
                  T3    wf:docs-t3       Haiku 5.5    high
                  T4    wf:docs-t4       Sonnet 5.5   low
    ...
    debugger      T1    wf:debugger-t1   Sonnet 5.5   low
                  T2    wf:debugger-t2   Sonnet 5.5   medium
                  T3    wf:debugger-t3   Sonnet 5.5   high
                  T4    wf:debugger-t4   Sonnet 5.5*  medium
    git           all   wf:git           Haiku 5.5    medium
    * runs on a stand-in: its set model is not installed

  ⚠ T5 not installed: a T5-sized task runs as T4
  ⚠ reviewer not installed: a coder of the tier reviews in a separate read-only
    round when asked
  ⚠ Opus 5.5 not installed: debugger-t4 runs on Sonnet 5.5
  ℹ Skills: orchestrator 5 · planner 3 · docs 2 · coder 3 · tester 4 ·
    debugger 4 · git 2

  Plan  93 create · 0 update · 0 remove · 0 unchanged
    ✚ create  ai-agents-setup/plugin/.claude-plugin/plugin.json
    ✚ create  ai-agents-setup/plugin/agents/ (22 files)
    ...

  ✔ Summary: Install

  ✔ Applied 93 changes. Backup: 20261028T162415Z (node wf.mjs restore puts it
    back).
  ✔ verify: claude plugin validate passed
  ✔ verify: 93 files match.

  Next: run wf in a project folder.
```

### Saved answers, --yes and --reset

The install manifest saves all four answers: tiers, agents, models and skills. The next install starts every list from them, and anything added to wf since (a tier, an agent, a model or a skill) comes with its default: the git agent, for example, comes ticked on the first install that knows it, while a git agent you unticked once stays unticked. `diff`, `doctor` (its `choices` line) and every reinstall use the saved answers too, so a smaller setup survives updates.

`--yes`, or a run without a terminal, asks nothing and installs the saved answers (on a first install: everything, with the recommended skills):

```
node wf.mjs install --yes
```

`--reset` starts from the defaults instead of the saved answers: in a terminal every list starts as on a first install, and together with `--yes` it installs everything with the recommended skills. `--skills-reset` is its old name and still works.

```
node wf.mjs install --reset
```

### What a missing tier, agent or model means

The orchestrator's instructions get one note per tier or agent you left out and one per unticked model that an installed agent was set to (`Everything is installed.` when there is none), and it follows them in every task:

| Not installed | What happens instead |
|---|---|
| a tier (T1 to T5) | A task of that size runs as the nearest installed tier, the higher one on a tie: a missing T3 runs as T4, or as T2 when T4 is missing too. The summary's Tier line says so, and the final report repeats it on its Setup line. |
| planner | A coder of the task's tier writes plan.md in a separate plan-only round before the implementation, at every tier. |
| docs agent | Each coder does the docs steps of plan.md in its own package (`wf: docs: in the coders' packages`), following the docs-writing skill. |
| tester | Each coder writes and runs the tests of its package after its code (`wf: tests: in the coders' packages`), following the testing skill: expected values come from the approved summary and plan, never from the code's own output. |
| reviewer | When you ask for a review, a coder of the task's tier does a separate read-only review round with the checks and severity scale of the code-review skill; the summary's Review line and the report's Setup line say so. |
| debugger | A failure that comes back for the same reason gets one more coder fix round, within the cap of 2 per phase; when it fails again, it goes to the report. |
| git | The git phase leaves the work uncommitted, also when you asked for git work: the summary's Git line says so and keeps every git action you asked for (a commit, or a push and pull request, a branch name or base, a merge, or any other action such as deleting branches), and the report lists the commands for exactly that to run yourself (`git switch -c <branch>`, `git add -- <the task's files>`, `git commit -m "<subject>"`, and for a push or pull request `git push -u origin <branch>` and `gh pr create --fill`, with `--base <base>` when you named a base, for a merge `gh pr merge --merge`, and for any other action the git or gh command that does it, for example `git branch -d <branch>` or `git push origin --delete <branch>`). |
| a model | Its agents run on the nearest ticked model, the stronger one on a tie, with the same effort. The install summary marks them with `*`. |

### Updating

From your clone folder:

```
git pull
```

```
node wf.mjs install
```

In a terminal the five steps come back with your saved answers: press enter on each list and choose Install to keep them. A second install with nothing new reports `0 changes: wf is up to date.` When an update brings a new role (the debugger and the git agent came this way), the agents step shows it ticked, and until you install again doctor's `choices` line warns, for example `debugger is new: node wf.mjs install adds it`, or `debugger, git are new: node wf.mjs install adds them` on an install older than both (after `no saved choices;` on an install from before the installer choices). A new agent of a role you already have, such as `wf:planner-t1`, is added by the next install without a question.

### Uninstalling

From your clone folder. It asks first, backs everything up, removes what wf installed and keeps `backups/`, `adopted/` and your `local.json`; `node wf.mjs restore` brings it back:

```
node wf.mjs uninstall
```

### Coming from v1

When install finds a v1 install (its manifest says `wf.manifest/1`), it migrates once and prints a `v1 migration` block before the plan (in a terminal on the summary screen, so Install confirms the migration too). Everything it touches is backed up first. It removes the v1 agents (`agents/wf-*.md`) and the v1 hooks folder, replaces the v1 launcher and house rules, puts back your own `agents/Explore.md` when the saved original still matches, and removes the v1 hook handlers, deny rules and env entries from `settings.json`, keeping everything else in that file (your own hooks and settings, its indentation). This is the only time install writes `settings.json`. The home folder trust and `ai-agents-setup/cost/` stay as they are. `uninstall` refuses a v1 install until install has migrated it, and `restore --to <stamp>` with the migration's backup stamp puts v1 back. Close any running v1 `wf` session first: it loses its v1 agents and hooks.

## Daily use

Open a terminal in a project (a git repository is best: without one there is no git phase) and start wf:

```
wf
```

In PowerShell and cmd on Windows, start it with `wf.cmd` instead: plain `wf` opens the firewall console there (see Troubleshooting). Then type or paste your request. You can also pass it at once, as `wf "add a --json option to the stats command"`; any other arguments go to `claude` unchanged.

### The flow

| Phase | Runs when | Who |
|---|---|---|
| Triage | always, silently: scores difficulty and risk to pick the tier (see [How a task gets its tier](#how-a-task-gets-its-tier)), picks the phases and the git wish | orchestrator |
| Discussion | until you explicitly approve: every turn ends with choosable options, and nothing changes before your Approve | orchestrator |
| Summary and approval | always, except T0 questions; the only approval | you |
| Branch setup | only when the approved summary wants the work itself done on a new branch, or names a base branch other than the current one | git agent |
| Plan | after the approval, at every tier | planner |
| Docs | the project has docs the change affects, or you asked | docs agent |
| Implementation | always | coders, up to 5 at once for independent parts |
| Tests | the project has tests, or you asked; always after the code | tester |
| Verification | the project has its own checks (lint, typecheck, build): one run, in the last worker round; a review only when you asked | tester or coder, reviewer |
| Repeated failure | during implementation, tests or verification, only when the same failure comes back after a coder fix round (see [Fix rounds and the debugger](#fix-rounds-and-the-debugger)) | debugger |
| Git | only when the approved summary asks: any git work its Git line names, such as a commit on a branch, branch, push and pull request, a merge, or another git action | git agent |
| Report and cleanup | always | orchestrator |

This is the flow with everything installed. When you left an agent out at install, its work moves to a coder of the tier, and without the git agent nothing is committed (see [What a missing tier, agent or model means](#what-a-missing-tier-agent-or-model-means)).

As soon as any worker runs, the orchestrator only delegates: planning, docs, code, tests, checks, reviews and git are all worker rounds, and the orchestrator writes nothing but its own task notes in `.work/`. During triage and the discussion it reads only what it needs to understand your request (file names, a quick look); the planner explores the code after the approval.

- **Plan**: the planner of the task's tier (Haiku at T1, Sonnet at T2 to T4, Opus at T5) writes plan.md: packages, files, checks, and the library skills each package needs. A package is sized by what its worker has to understand, not by its file count, so a mechanical edit across many files stays one package. When the code shows the task is harder than the summary's tier, the plan raises the tier for the rest of the task; it never lowers it.
- **Implementation**: one coder per package, up to 5 at once for packages that depend on no other open package and share no file with another. The limit is wf's own (Claude Code allows more): the coders share one working tree, their checks run side by side, and every result lands in the orchestrator's context.
- **Verification**: the project's check commands run once, in the last worker round: the tester's when there is a tests phase, otherwise a coder's checks-only round. After a later fix round, that coder (or the debugger) runs them all again, so the report always shows a run after the last change.
- **Git**: the git agent `wf:git` does every git write the Git line names (commit, push, pull request, merge, branch deletion and any other); the orchestrator itself runs read-only git only (see [Safety](#safety)).

T0 is the short way: a question gets a direct answer with no approval, and one obvious edit (nothing to commit) gets an approval question with the answers Approve, Change something, Cancel and Something else (see [The approval](#the-approval)). Its text is a one-line summary of the change that names the file when it is outside the project and says that nothing is committed, then `Approve this edit? After that I make it and reply in one or two lines.` After Approve the orchestrator makes the edit itself, runs the project's fast check for that file when there is one, and replies in one or two lines: no task folder, no agents. Nothing else starts. An answer never changes anything, even when it finds something to fix: when it suggests changes, it ends with a multiple choice question (`Which of these should I prepare as a task?`, with at most 2 suggestions, the most valuable first, `None for now` and `Something else`), and what you pick, or a reply such as "do it", starts a discussion and a summary for your approval, never the work. Asking for a commit, push or pull request makes even a one-line edit T1, so the git agent can do it; without the git agent installed the edit stays T0, nothing is committed and the reply lists the git commands.

Every wf session answers in Claude Code's built-in Concise output style, and every worker follows the same reply style (see [Isolation](#isolation)).

Failing checks, test failures the tester traces to product code, and blocker or major review findings go back to a coder, at most 2 fix rounds per phase; what is still open after that goes in the report. A failure in code the task did not touch is pre-existing: it goes straight to the report, marked as such. Minor review findings are only reported. Neither gets a fix round. Workers decide open choices themselves and list them as assumptions.

### Fix rounds and the debugger

The orchestrator records every failure in progress.md with a signature: the check or test name and the core of its error (the message without paths, line numbers or timings), or for a review finding its file and claim. Workers make this possible: a check that fails gets one line per failing test with its first error line, and its full output goes to a log in the task's `notes/` folder. Each failure is open, fixed or reported.

1. A new failure gets a coder fix round, as before.
2. When the same signature fails again after that round, the debugger takes it instead of another coder round. It runs alone: the orchestrator lets running coders finish first and starts no other worker that edits files until the debugger is done. It gets the signature, what each attempt tried and the files involved; it reproduces the failure with the exact command, finds the root cause with evidence, applies the smallest fix, reruns the failing check and the related checks, and reports the root cause.
3. The orchestrator then decides by one thing alone: the last run of the exact failing command, which the debugger reports under Checks (when it ran none, a coder's checks-only round runs it; for a review finding, a recheck). It passes: the task goes on (when the debugger could not reproduce the failure, the report notes it as possibly flaky). It still fails: the failure goes to the report with the debugger's root cause, and no further round follows.

A different failure after a fix counts as new: a normal coder round, within the cap of 2 coder rounds per phase (a debugger run does not count against it). A failure that went to the report stays there: when it shows up again in a later phase, it gets no further round. The debugger runs at most once per signature and at most twice per task, and it never hands off: when its context fills up, it ends with its analysis so far. When the debugger is not installed, already ran for that signature (the failure came back after its fix), or has run twice in the task, a repeated failure gets one more coder round within the cap, then goes to the report. Each fix round and each debugger run prints its own status line.

### The approval

While points are still open, every turn of the discussion ends with questions with answers you can pick: at most about 3 per turn, each with 2 or 3 answers, the recommended one first and marked `(Recommended)`, and always a last answer, `Something else`, where you type your own (every question wf asks has it). It never asks about git, the tier, the phases, docs, tests or a review: the summary states them, and you change them there with Change something. The first question starts with a short picture of where things stand, for example:

```text
📍 **Where we are**
- ✅ Decided: a --json option for the stats command; the plain text output stays
- ❓ Open: should --json also cover the summary line?
- 👉 Now I need: your answer on the summary line
```

A point never drops out of that picture: it moves from Open to Decided, also when you leave it out. As soon as nothing is open, the orchestrator prints a short summary in plain words, for example:

```text
🎯 **What you want**
- The stats command gets a --json option that prints the same numbers as JSON

🔒 **What stays the same**
- Everything else, including the plain text output

🚀 **What will run**
- 📋 Plan and implementation
- 📝 Docs: the README lists every option
- 🧪 Tests: the project has tests
- 🔎 Checks: lint and typecheck

🌿 **Git**: leave uncommitted: nothing is committed

📊 **Tier**: T2: new user-facing behavior in one module, needs new tests

⏰ **Estimate**: about 15 to 30 minutes

👉 **Now I need**: your answer below: approve all of this, change something, or cancel.
```

The Tier line gives the tier with the short reason from triage. The Estimate line is the wall-clock time from your approval to the report, judged from the tier, the phases and the size of the task (typically T1 5 to 15 minutes, T2 15 to 30, T3 30 to 60, T4 60 to 120, T5 120 minutes or more, given in hours above 2 hours); every summary has it. The Git line follows what you asked. The usual forms:

| You asked | Git line | What the git agent does |
|---|---|---|
| nothing about git | `leave uncommitted: nothing is committed` | nothing: you review the changes in your working tree |
| a commit | `commit on a branch` | commits the task's own files on a feature branch |
| a push or a pull request | `branch, push and open a pull request` | commits on a feature branch, pushes that branch and opens a pull request |
| another git action, e.g. delete merged branches | `delete the merged branches, local and remote` | runs exactly that action |

Any git action you ask for goes on the Git line in plain words, alone or after one of these forms, for example `commit on main and push it`, or `branch, push and open a pull request, then merge it and delete the branch`. The Git line names every git action you asked for, with the branches, tags and remotes you named, and nothing you did not ask for: the git agent does exactly what it says. Unless you ask otherwise, a commit lands on a feature branch and a push comes with a pull request. `, then merge it` is added only when you asked for the merge, the branch name or base when you gave one, and `; branch set up before the work` when you want the work itself done on that branch from the start, or when you named a base branch other than the current one, so the new branch starts from that base while the working tree is still clean. Without the git agent installed, a git wish becomes `leave uncommitted: no git agent is installed; asked: <the Git line it would have, with the branch, base and merge>; the report lists the commands`, so the report lists the right commands even after a compaction or a resume.

The summary lists every change the work will make, by name also a change outside the project (your own settings, another folder), and under Left out each point you dropped; what it does not list is not approved.

The summary sits inside the question itself, followed by `Approve this summary? After that I work without questions until the report.`, with the answers Approve, Change something, Cancel (drops the request; nothing changes) and Something else (type your own answer). A summary too long for one question is split at a section break into two questions asked together, `Approval 1/2` and `Approval 2/2`, each with the same four answers: the work starts only when you pick Approve in both, a Cancel in either cancels, and any other pair counts as Change something. The Where we are picture also sits inside its question: text written beside a question can go missing in the terminal, the question is always shown. Until your Approve the orchestrator only reads and talks: it changes not a single line in any file or setting. It asks back until nothing is open: your questions, doubts and unanswered points. Every one of its turns shows where things stand and ends with a question of choosable options: while points are open, the Where we are picture and questions about them; once nothing is open, the full summary and the approval question, on every turn until you pick Approve or Cancel, also right after it answers a side question of yours. The one exception is a turn in which the orchestrator compacts itself: it ends with one short line, and the picture comes back right after the compaction (see [How the orchestrator compacts itself](#how-the-orchestrator-compacts-itself)). Only Approve, a typed answer that does nothing but approve, or "approved, no questions" written in the request itself starts the work; "ok", "yes" or "do it" said earlier, an answer to a discussion question, or an approval that also asks or changes something keeps the discussion going, and after any change the summary is printed again in full and asked again. After Approve nothing asks you anything until the report, with two exceptions: a hard contradiction that makes the summary impossible to follow (one question: the recommended way out, one alternative, stop the task or Something else), and the resume question when a later session finds the task unfinished (see [Nothing left behind](#nothing-left-behind)). You can still write at any time: the orchestrator answers briefly, follows a change that drops or narrows the work, says in one line that anything new waits for the report and does none of it in this task (the report lists it under Follow-ups as `Waiting: <it>`, and your next message about it starts its own triage, discussion, summary and approval), and stops everything when you ask it to.

Tips: start the request with `T0:`, `T1:`, `T2:`, `T3:`, `T4:` or `T5:` to force a tier (a tier you did not install runs as the nearest installed one); say "commit" for a commit on a feature branch, or "push" or "open a pull request" for branch, push and pull request (otherwise nothing is committed), and "merge it" only when you want the merge too; you can ask for any other git action in plain words, such as "delete the merged branches" or "commit on main" (without the git agent installed nothing is committed even when you ask: the report lists the git commands to run yourself); ask for a review to get the reviewer (or a coder's read-only review round when the reviewer is not installed); write "approved, no questions" in the request to approve in advance.

### Status lines

Workers run in the background, so the session stays responsive. At every phase change you get one line `wf: <phase>: <short status>`, for skipped phases too. Inside a phase, each fix round and each debugger run gets its own line, at the start and for the debugger's outcome. For example:

```text
wf: plan: started
wf: implementation: 2 coders started (P1, P2)
wf: verification: lint pass, typecheck pass, build fail
wf: verification: fix round 1 started (build: Cannot find module x)
wf: verification: debugger started (build: Cannot find module x)
wf: verification: debugger fixed build: Cannot find module x
wf: git: skipped, leave uncommitted
wf: report: done
```

### The report

The last message has the sections `✅ **Done**`, `📁 **Changed files**`, `🧪 **Checks**` (one line per command: `✅ <command>: pass`, `❌ <command>: fail (...)`, or `⏳ <command>: not rerun after the last fix (was pass)`), `💡 **Assumptions**`, `🚧 **Not done or failed**` (a failure the debugger could not clear appears there as `<failure>: still failing after the debugger; root cause: ...`), `🔜 **Follow-ups**` (new work you asked for after the approval shows there as `Waiting: <it>`), a `🧩 **Setup**` line only when something missing changed this task (it ran as another tier because its own is not installed, a coder reviewed because no reviewer is installed, or you asked for git without the git agent installed; for example `ran as T4 (T5 is not installed)`, `review by a coder (no reviewer is installed)` or `not committed (no git agent is installed)`), and one git line that starts with `🌿 `:

- `Committed on <branch>: <short hash> <subject>`, plus `, pushed to <remote>/<branch>`, `, pull request <url>` and `, merged` for what the git agent did;
- `Nothing was committed: review the changes in your working tree.` when you asked for no git and nobody committed, moved a branch or stashed during the task;
- `Not committed: no git agent is installed. To do it yourself:` and the commands, one per line;
- `HEAD or refs moved during the task: <old>..<new>; wf did not commit` when someone else committed, moved a branch or stashed during the task: wf then commits nothing;
- or `Not committed: <reason>` or `Pull request not opened: <reason>` when an approved commit, push or pull request did not happen: a refusal, a failing hook, a rejected push, a secret-check hit, or a missing remote or gh login. The reason and the commands to run yourself also go under Not done or failed.

Edits that someone else made during the task are listed and left unstaged: the git agent stages only the files the task's workers changed that had no uncommitted changes when the task started. A file that already had changes before the task stays unstaged too, even when a worker changed it, so your own earlier edits are never committed. The report lists the files left unstaged under Not done or failed.

### Session names

A wf session gets a name you can find again in the session list. At your first message, a hook (`hooks/title.mjs`) asks a small Haiku model for a short name made from that prompt and sets the session title to the name in sentence case with spaces and no prefix, for example `Fix login timeout`: the tier is not known yet. If the model does not answer within 12 seconds, the hook builds the name from the first words of the prompt. A prompt that is empty or starts with `/` is skipped and names nothing.

After the first approval of the session, at your next typed message, the session is renamed once to `wf(T<n>)-` plus that task's short name in the same style (the slug of its task folder, with spaces and sentence case), for example `wf(T3)-Login fix`. The tier `<n>` comes from the Tier line of the approved summary; when the summary has no readable Tier line, the new name has no prefix. Later approvals in the same session never rename it again, and a later tier raise by the planner does not rename it either.

A title you set yourself, with `/rename` or in the session list, is never overwritten: once the hook sees one, it stops naming that session. The hook sends one small Haiku request per session and prints nothing else, except the empty terminal title after `/clear`. It runs only in the plugin you install; a live install gets it after you run the installer again.

After `/clear` the old session title is gone and no title is shown. Nothing is named until your next typed message, which names the new session. Sessions named earlier with `[WF] ` or `wf-` keep working.

### Nothing left behind

During a task wf keeps its notes in `<project>/.work/<YYYYMMDD-HHMM-slug>/` (summary.md, plan.md, progress.md, handoff notes, notes/), and `.work/.gitignore` holds `*`, so git never sees them. At the report the orchestrator stops the keep-warm watcher and every worker, then `wf-clean` deletes the task folder, and `.work/` too when nothing else is in it. Only the context ledger stays, in the install folder, pruned after 7 days.

When a session ends in the middle of a task, the next `wf` session in that project asks, at your first message, what to do with it: Resume (no new approval), Discard (deletes the task folder, your project files stay), Leave it or Something else (type your own answer; an unclear one gets the question again). A task of another session that was active in the last 75 minutes counts as still running, also when that session has just ended or crashed: it gets no question, and `wf-clean` refuses to delete it unless given `--force`. A new request you type while a resumed task runs waits for that task's report.

## Tiers and models

| Role | T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|
| orchestrator (main thread) | Sonnet 5.5 medium, one `wf:orchestrator` for every tier | | | | |
| planner | Haiku 5.5 medium | Sonnet 5.5 low | Sonnet 5.5 medium | Sonnet 5.5 high | Opus 5.5 high |
| docs | Haiku 5.5 low | Haiku 5.5 medium | Haiku 5.5 high | Sonnet 5.5 low | Sonnet 5.5 medium |
| coder | Haiku 5.5 low | Haiku 5.5 medium | Haiku 5.5 high | Sonnet 5.5 medium | Sonnet 5.5 high |
| tester | Haiku 5.5 low | Haiku 5.5 medium | Haiku 5.5 high | Sonnet 5.5 medium | Sonnet 5.5 high |
| reviewer (only on request) | Haiku 5.5 medium | Sonnet 5.5 low | Sonnet 5.5 medium | Sonnet 5.5 high | Opus 5.5 high |
| debugger (only for a repeated failure) | Sonnet 5.5 low | Sonnet 5.5 medium | Sonnet 5.5 high | Opus 5.5 medium | Opus 5.5 high |
| git (only when the summary asks) | Haiku 5.5 medium, one `wf:git` for every tier | | | | |

High effort is used for the coder, tester and debugger at T3 and T5, the docs agent at T3, and the planner and the reviewer at T4 and T5. Every 5.5 model has a 1M token context window. The agents are `wf:orchestrator`, `wf:<role>-t<n>` and `wf:git` (32 in all with everything installed: the orchestrator, 5 each of planner, docs, coder, tester, reviewer and debugger, and the one git agent), with model and effort pinned: `wf-settings.json` denies `Agent(model:*)` and `Agent(effort:*)`, so nobody overrides them at run time. It also denies the tools wf never uses (`Artifact`, `Workflow`, `ScheduleWakeup`, `SendFeedback`, `ReportFindings`, `ListAgents`), so a wf session does not load them: in a headless start that took about 17K tokens off the first prompt (Artifact takes ArtifactComments and ArtifactData with it). Your normal `claude` keeps them all. The table shows a full install: steps 1 to 3 of install can leave out tiers, agents and models (see [What a missing tier, agent or model means](#what-a-missing-tier-agent-or-model-means)). To change a model or an effort, edit `roles` in `registry.json` and rerun install.

### How a task gets its tier

Difficulty and risk decide the tier, never the number of files: replacing one email address in 30 files is still a very small task. Triage scores the change on twelve factors, 0 to 2 each, total 0 to 24:

| Factor | 0 | 1 | 2 |
|---|---|---|---|
| Ambiguity | fully specified | small choices | design decisions |
| Reasoning | mechanical: replace, rename, version bump | local logic | cross-cutting or algorithmic |
| Coupling | one concept | one module's behavior | several modules, a public interface or a stored format |
| Risk | none | user-facing behavior | security, data, money, migrations, concurrency or anything irreversible |
| Verifiability | existing checks cover it | needs new tests | hard to verify: timing, UI feel, external services |
| Precedent | the project already does the same thing | a similar pattern to adapt | nothing like it in the project |
| Context | a few lines or one file to understand | one module and its callers | many modules or long code to understand |
| Reversibility | a revert undoes it | needs cleanup beyond a revert: generated files, installed copies, caches | cannot be undone: data written or deleted, a release, a sent message |
| Outside dependencies | none | a library or tool the project already uses | external services, APIs, networks or tools outside the project |
| Domain | general code | a domain with its own rules: dates, time zones, i18n, layout, regexes | specialist knowledge: security, cryptography, money, compilers, numerics, legal rules |
| Concurrency | sequential | async order matters in one place | parallel work, shared state, locks, races or retries |
| Backward compatibility | nothing depends on the old behavior | internal callers or saved settings must keep working | a public API, CLI, file or stored format, or users' existing data must keep working |

| Tier | Total | Example |
|---|---|---|
| T0 | any answer; or 0 to 2 and one obvious edit. The orchestrator alone, no agents | fix a typo (0) |
| T1 | 3 to 6; or 0 to 2 when it is more than one obvious edit | replace an email address across 30 files (1); a new CLI flag that only prints a value (about 6) |
| T2 | 7 to 10 | a new validation rule with its messages and tests in one module (about 8 to 10) |
| T3 | 11 to 14 | a new installer step across several modules, the saved manifest and the docs (about 14) |
| T4 | 15 to 19 | a migration that renames a column (about 16); a job queue with parallel workers, retries and a new stored format (about 19) |
| T5 | 20 to 24 | moving stored passwords to a new hashing scheme on live data (about 20); a payment flow change across services with a data migration (about 22) |

Overrides, after the total: risk 2 in the logic being changed means at least T2 (a mechanical edit inside risky files does not count); asking for extra care means T5. When unsure between two tiers, the discussion settles it, else the higher one wins. The planner may raise the tier after reading the code, never lower it. A prefix (`T0:`, `T1:`, `T2:`, `T3:`, `T4:`, `T5:`) wins over the score; a tier you did not install then runs as the nearest installed one. The summary's Tier line gives the short reason, for example `T4: several modules, a stored format, needs new tests`.

## Skills

| Skill | Source | Required for | Ticked by default for |
|---|---|---|---|
| discussion | ours | orchestrator | |
| triage | ours | orchestrator | |
| execution-plan | ours | orchestrator, planner | |
| final-report | ours | orchestrator | |
| context-cache | ours | all eight roles | |
| javascript | ours | | planner, coder, tester, reviewer, debugger |
| testing | ours | tester | coder, debugger |
| vitest | ours, with the vendored antfu/skills Vitest reference | | tester |
| docs-writing | ours | docs | |
| code-review | ours | reviewer | |
| debugging | ours | debugger | |
| git | ours | git | |
| seo | vendored from addyosmani/web-quality-skills, patched | | reviewer |
| core-web-vitals | vendored from addyosmani/web-quality-skills | | reviewer |
| web-performance | vendored from addyosmani/web-quality-skills (performance) | | reviewer |
| accessibility | vendored from addyosmani/web-quality-skills (WCAG 2.2) | | reviewer |

How they reach the agents: install copies every skill to `plugin/library/<name>/` (not a Claude Code skills folder, so they never show up as `/` skills or trigger on their own). The skills ticked for a role are inlined into that role's agent file, so they are always loaded and survive compaction. Every agent file ends with a "Skill library" index of the other installed skills (name, description, path); the planner names the ones each package needs and the worker reads them on demand. A coder that stands in for a missing planner or reviewer reads execution-plan or code-review from the library the same way.

The git skill is the git agent's rulebook. Its first rule, in bold: do exactly the git work the approved summary's Git line names, and nothing else. Any git or gh command is allowed for that work (deleting branches, a force push, a push or commit to main, rebase, reset, tags, amend, merge); a git action the Git line does not name is never run. It also covers branch names (`<type>/<slug>`, or the name you gave), staging only the task's own files from the orchestrator's list, a secret check before every commit, the commit message (from the project's own style), the pull request title and body (from the summary and the checks), merges only when the summary asks, and no `--no-verify` unless asked.

### Adding a skill

1. Create `skills/<name>/SKILL.md` in your clone (`<name>`: lowercase words joined by hyphens). Optional extra files go in `skills/<name>/references/`; only text files.
2. Start it with this frontmatter:

```text
---
name: my-skill
description: One line, at most 300 characters, saying what it covers and when to use it.
metadata:
  wf-required: [tester]
  wf-default: [coder, reviewer]
---
```

`name` must equal the folder name. Roles are orchestrator, planner, docs, coder, tester, reviewer, debugger and git. `wf-required` roles always get it (locked in the checklist), `wf-default` roles get it ticked; both may be `[]`. In the body, `{{skillDir}}` becomes the installed folder of the skill, for links such as `{{skillDir}}/references/x.md`, and `{{libraryDir}}` becomes the installed library, for a link to another skill such as `{{libraryDir}}/testing/SKILL.md`. Any other `{{word}}` in SKILL.md that is not a wf placeholder is a lint error and stops the install, so write a template example with spaces, as in `{{ title }}`.

3. From your clone folder, check it:

```
node wf.mjs lint
```

4. Install again: the skills step (step 4) shows the new skill, ticked for its default roles even where you saved an answer before. No other file needs a change.

```
node wf.mjs install
```

### Vendored skills and licenses

seo, core-web-vitals, web-performance and accessibility come from addyosmani/web-quality-skills at commit `afa8da9` (MIT, Addy Osmani); the Vitest reference under `skills/vitest/references/` comes from antfu/skills at commit `8886fe2` (MIT, Anthony Fu). Each folder keeps the upstream `LICENSE` and a `SOURCE.md` with the upstream URL, the pinned commit, the date and every local change: dashes replaced under the house rules, no global installs or remote code, and for seo three fixes to match Google (no rel=prev/next, never canonicalize page 2 and later to page 1, Google ignores changefreq and priority). No scripts are vendored.

## Context window management

100 percent always means the full 1,000,000-token window, so the zones are absolute:

| Context used | What happens |
|---|---|
| below 500K | nothing |
| 500K to 800K | the buffer: an agent estimates what it still needs. When used plus needed stays under 800K it goes on. Otherwise a worker finishes the current step and hands off, and the orchestrator compacts itself at the next point where no worker runs |
| 800K and above | a worker hands off now; the orchestrator compacts at the end of its current turn, whatever runs |
| 850K | the engine's own automatic compaction inside a turn: the backstop |

A wf hook measures each agent's context after every tool call from its own transcript and adds a short `wf context:` notice to that agent: on entering the buffer, then every further 50K, and from 800K every 5 tool calls. A worker that hands off writes `handoff-<role>-<n>.md` in the task folder and ends with `Status: handoff`; the orchestrator starts a fresh worker of the same agent from that note. The reviewer has no Write tool, so it puts the note's sections at the end of its Open issues and the orchestrator saves them as `handoff-reviewer-<n>.md`. The debugger never hands off: it writes no note and ends blocked with its analysis so far, and the orchestrator decides by a rerun of the failure. Before the orchestrator resumes a finished worker for a fix round, it checks the ledger (`wf-agents`) and starts a fresh one instead when the work would pass 800K.

### How the orchestrator compacts itself

The orchestrator cannot hand off, so it compacts its own conversation. A model cannot run `/compact`, so the wf plugin ships a hooks module, `hooks/compact.mjs`, that adds one tool, `mcp__wf__compact`, and runs the compaction itself. A plugin can make Claude Code compact only between turns, so the module does it when an orchestrator turn ends:

1. From 500K, at each `wf context:` notice, at each new request and before each round of workers, the orchestrator estimates what the rest of the task still brings in. When that stays under 800K, nothing happens.
2. When it would pass 800K, the orchestrator starts no new worker. Once every running worker's result is in and noted in progress.md (with each worker's changed files and the last check results, which the report and the git phase need), it updates progress.md, calls `mcp__wf__compact` with `next` (the step it would take now) and ends its turn with one short line.
3. When that turn ends, the module checks the running subagents (`$.agent.list()`). If none runs, it compacts, so no worker result arrives while the conversation is being rewritten. Otherwise it waits for the next turn end with none running.
4. After the compaction it wakes the orchestrator with a message that starts with `wf compaction done` and repeats `next`. The orchestrator rereads progress.md, summary.md and plan.md and takes that step. The message comes from the plugin, not from you, and approves nothing.
5. From 800K the compaction is due at once. With a task folder the orchestrator updates progress.md; it calls the tool and ends its turn, also in the discussion. The module compacts at that turn's end whether workers run or not, and also when the orchestrator did not call the tool. When the orchestrator called the tool and no worker runs, the `wf compaction done` message of step 4 wakes it. Otherwise nothing wakes it: running workers go on, and their results, or your next message, reach it after the compaction.

Two things come first. Right after an approval the orchestrator writes the task folder, summary.md and progress.md before it compacts, because only summary.md carries an approval through a compaction. And it never calls the tool in the turn that ends with the report or a T0 answer; a turn that ends with the report also drops a queued request, so nothing follows the report (past 800K that turn is still compacted, without a wake-up).

In every case the PreCompact hook lists what the summary must keep, and when the orchestrator called the tool the module adds its `next` step. You see a dim `wf: compacting the orchestrator's context at <n>K` line in the transcript (when workers still run past 800K, it ends with `with <n> worker(s) running`), and a queued compaction that waits for workers shows `wf: compaction waits until no worker runs (<n> running)` once. The engine's own compaction at 850K stays as the backstop inside a long turn, for example while an AskUserQuestion waits. The tool refuses a call below 500K and a call from a worker. A turn the wake-up started never wakes the orchestrator a second time, a `/clear` or a resume drops a queued request, and so does a turn that ends below 500K.

Limits: plugin compaction works in an interactive session, which is how `wf` runs. In a headless `claude -p` run it is not available: the module registers no tool there, and only the engine's 850K backstop applies. The module writes no `state/hook-errors.log`: its failures show as a dim transcript line, such as `wf: compaction failed: <reason>`, and a missing `hooks/config.json` shows in the debug log. The module uses the plugin hooks API of Claude Code 2.1.312, which is early access and may change in a later release: `node wf.mjs install` runs `claude plugin validate` on it, and `node wf.mjs doctor` reports a missing module.

Why wf never sets `autoCompactWindow` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: in Claude Code 2.1.312 both redefine the window itself, so 100 percent would become the smaller number and every zone would move. The launcher sets only `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=86.74`, which moves the trigger and leaves the window at 1M: 86.74 percent of 980,000 (the window minus the 20K output reserve) is 850,052 tokens. `node wf.mjs lint` refuses the two settings in the sources. wf sessions still read your own `settings.json`, so keep `autoCompactWindow` out of it too.

## Prompt cache

- Each agent sets its own cache in its frontmatter, `experimental.cacheTtl`: coder and debugger `"1h"`, tester, planner, docs, reviewer and git `"5m"`. The orchestrator keeps the main-thread default, 1 hour on a subscription.
- A 1 hour write costs 2x the input price against 1.25x for 5 minutes, but a worker that waits for the next phase does not pay the rewrite again. A 5 minute agent that waits longer than 5 minutes pays the rewrite when it resumes, unless the keep-warm has pinged it (up to 30 minutes after its last work).
- The launcher no longer sets `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`. That variable beat the per-agent setting, so every worker used to write 1 hour entries.
- Every subagent of the session is kept warm: the `wf-keepwarm` watcher finds them by itself, from the session's ledger, finished ones included (tester, planner, docs, reviewer, git, coder and debugger). The orchestrator no longer passes `--agents`. The flag still works for an agent the ledger does not hold (one that made no tool call): if that agent cannot be found, the watcher exits with `cannot find agent <id>`.
- Keep-warm at 58 minutes, for the main thread and the 1 hour agents (coder and debugger): right after the approval the orchestrator starts the `wf-keepwarm` watcher in the background. It polls every 20 seconds, costs no tokens while it waits, and exits as soon as the main thread or a 1 hour agent has been idle for 58 minutes, with one `wf keep-warm: ping <main|agent id> (idle <n> min)` line per agent that is due. That wakes the orchestrator: its own wake-up turn refreshes the main thread, and a worker gets the message `wf keep-warm ping: reply ok only`. Then the watcher starts again.
- Keep-warm at 4 minutes, for the 5 minute agents (tester, planner, docs, reviewer and git): the same watcher pings each of them about every 4 minutes, but only while its last real work is at most 30 minutes old (a ping does not count as work). After 30 minutes the watcher stops pinging it, so resuming it later pays the cache rewrite. A worker that is still running is not pinged, since it keeps itself warm, and the git agent's reply `ok` is ignored: its result stays final.
- Cap: after 6 main-thread pings in a row with no other activity (about 6 idle hours) the watcher is not restarted; your next message starts it again. At the report it is stopped and nothing keeps running.
- Not yet verified live: `experimental.cacheTtl` is read from the Claude Code binary, not from its documentation. wf's tests check that the installed agent files carry it; that a worker's cache really switches tier is still to be checked in a transcript.

## Isolation

The launcher (`~/.local/bin/wf`) is a small script:

```text
#!/bin/sh
export BASH_DEFAULT_TIMEOUT_MS='600000'
export BASH_MAX_TIMEOUT_MS='600000'
export CLAUDE_CODE_THRIFTY_SONIC='0'
export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='1'
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='86.74'
export CLAUDE_CODE_DISABLE_FAST_MODE='1'
exec claude --plugin-dir '<install folder>/plugin' --settings '<install folder>/wf-settings.json' --agent wf:orchestrator "$@"
```

- `--plugin-dir` loads the plugin `wf` (agents, hooks, helper commands) for this session only; it is never installed into Claude Code's plugin list.
- `--settings` adds `wf-settings.json` (the allow rule for `mcp__wf__compact`, the deny rules for `Agent(model:*)`, `Agent(effort:*)` and the tools wf never uses, `"outputStyle": "Concise"` and `"ultracode": false`) on top of your normal settings, for this session only: a wf session never runs ultracode, even when your own settings turn it on.
- Concise answers: the main thread of a wf session gets Claude Code's built-in Concise output style, which wins over a project's own `outputStyle`. Subagents never receive an output style, so every worker carries a short Reply style section in its rules instead: lead with the result, no preamble, no narration between tool calls, no recap, short by default, structure only when it carries structure, no hedging, full detail when the delegation asks for it, and never brevity at the cost of correctness (errors, failing checks, security warnings, blockers and every field of the result block stay complete). Plain `claude` sessions keep whatever style you set.
- The environment lines exist only in the launcher: 10 minute Bash timeouts, workers cannot start agents of their own, the compaction trigger, `CLAUDE_CODE_THRIFTY_SONIC=0`, which turns off a Claude Code reminder that tells agents to change files with sed, heredocs or scripts, so workers edit with Write and Edit (kept from v1, decisions D32 and D36), and `CLAUDE_CODE_DISABLE_FAST_MODE=1`, which turns off fast mode for every model in wf sessions.
- A plain `claude` session sees no wf agent, skill, hook, setting or environment variable. The one global file is `~/.claude/rules/wf-house-rules.md`: the house rules apply in every Claude Code session on purpose.
- Install never writes `~/.claude/settings.json`, except the one-time v1 migration.

## Safety

The git guard (`hooks/guard.mjs`) checks every Bash command that mentions git or gh (on Windows every such PowerShell command too) and every Monitor command, in wf sessions only. It sees through `bash -c`, `sh -c` (their positional parameters too, as in `bash -c '"$@"' _ git commit`), `env`, `sudo`, `timeout`, `xargs`, `find -exec`, `command`, operators and subshells.

| Who | Read-only git and gh | Every other git and gh command (add, commit, push, `gh pr create`, merge, reset, force ...) |
|---|---|---|
| Workers (every `wf:<role>-t<n>`) | allowed | refused |
| The orchestrator | allowed | refused |
| `wf:git` | allowed | allowed: the guard does not check it; the approved Git line sets what it does |

- Read-only git: status, diff, log, show, blame, grep, ls-files, ls-tree, rev-parse, rev-list, describe, shortlog, merge-base, cat-file, show-ref, for-each-ref, check-ignore, var, version, help, `fetch [origin [<branch>]]`, branch and tag in list forms, stash list and show, remote -v and show, config --get and --list, worktree list. gh: read forms only. A read with a config override or an environment variable that points git at another program (a pager, an editor, an ssh command) is refused too, for example `GIT_PAGER=delta git log`, also when an earlier `export`, `declare -x` or plain assignment in the same command set the variable (`export GIT_PAGER=delta; git log`). `git grep -O<pager>` and `--open-files-in-pager=<pager>` (or an abbreviation such as `--op=`) are refused when the pager runs a git write.
- Only `wf:git` writes git, and the orchestrator starts it only when the approved summary asks for git work: a branch before the work when the summary says so, and the git phase at the end. It has no tools list, so it also gets MCP servers you add later (a GitHub one, for example). Its git skill sets no branch, force or history limit: it does only the work the Git line names, and nothing the Git line does not name. Without a named branch it commits on a feature branch and the change reaches main, master, develop or the repository's default branch through a pull request. It stages only the task's own files from the orchestrator's list, runs a secret check before every commit, and never uses `--no-verify` unless the summary asks. When it stops (a refusal, a failing hook, a rejected push, a secret-check hit, a missing remote or gh login), that result is final: the orchestrator never retries it on its own, and the report gives the reason and the commands to run yourself.
- A worker's refusal looks like `wf guard: subagent wf:coder-t1 may not run "git commit -m test": only wf:git runs git and gh writes; leave the changes in the working tree for the orchestrator.` The orchestrator's ends with `delegate them to wf:git only when it is installed and the approved summary asks for git work, else leave the work uncommitted and list the commands in the report.`
- When the guard cannot even start or times out (10 seconds), Claude Code blocks the command (fail closed). Any other hook error is logged to `state/hook-errors.log` and never blocks. Only the compaction module logs nothing there: its failures show as a dim line in the transcript (see [How the orchestrator compacts itself](#how-the-orchestrator-compacts-itself)).
- The guard cannot see git writes hidden inside script files or package scripts, nor variables a sourced file (`source` or `.`) sets; the house rules forbid routing a git write through them.
- An `allow-git` file from an older wf version gives nothing: the guard no longer reads it.

House rules (`prompts/house-rules.md`, installed as `~/.claude/rules/wf-house-rules.md`): code in English (Hungarian only in i18n data), no comments in code except TODO, never commit, push or run any other git write unless asked (for wf: only `wf:git`, only when the approved summary says so, exactly the git work the summary's Git line names: any git or gh command is allowed for that work, such as deleting branches, a force push, a push or commit to main, rebase, reset, tags, amend and merge, and nothing the Git line does not name; unless the Git line says otherwise it commits on a feature branch and opens a pull request), never an em or en dash, and every behavior change updates, in the same task and unasked, all docs and guidelines that describe it (README, docs/, guides, changelogs, skills, agent prompts, rule files): a change is not done while any of them still describes the old behavior. Workers also never delete with `rm` and a glob, a variable or a relative path; their scratch files go to the task's `notes/`.

## Commands

All of them run from your clone folder as `node wf.mjs <command>`; `node wf.mjs --help` lists them.

| Command | Flags | What it does |
|---|---|---|
| `install` | `--yes`, `--dry-run`, `--reset` (alias `--skills-reset`), `--json` | checks Claude Code, lints the sources, asks the five install steps (tiers, agents, models, skills, then the summary with the plan), compiles, backs up, writes, verifies (hashes and `claude plugin validate`) and prints a PATH hint when needed |
| `uninstall` | `--yes` | backs up, then removes everything wf installed (plugin, launcher, settings file, house rules, state); keeps `backups/` and `adopted/`, and puts back an adopted `rules/house-rules.md` |
| `restore` | `--to <stamp>`, `--yes` | puts a backup set back: the latest by default, which undoes the last install or uninstall; makes a backup of the current state first |
| `diff` | `--reset` | shows what install would change with your saved answers (with `--reset`: with the defaults), with line counts |
| `doctor` | | health checks: node, the hook node, Claude Code, launcher and PATH, file hashes, your install choices, plugin validate, v1 leftovers, state folder, a hook self-test |
| `lint` | `--self` | lints registry, personas, skills and the compiled agents; `--self` also checks the repository's house rules |

- `--yes` (`-y`) asks nothing: `install` takes the saved answers (the defaults on a first install), `uninstall` and `restore` skip their confirmation. In a terminal, install's only confirmation is Install on the summary screen. Without a terminal, `install` applies without asking, while `uninstall` and `restore` only show what they would do unless given `--yes`.
- `--json` (install only) asks nothing, installs like a run without a terminal and prints one JSON object with the result: `command`, `ok`, `code`, `choices`, `notes`, `changes`, `written`, `backup`, `messages` (and `error` when it failed).
- `--dry-run` (install only) asks nothing either and writes nothing. It shows the plan for your saved answers (with `--reset`: the defaults), a `would fail:` line for each planned write that would fail, and ends with `Dry run: N changes, nothing written.`
- For tests and sandbox trials only: `--config-dir <absolute path>` and `--launcher-dir <absolute path>` replace `~/.claude` (or `CLAUDE_CONFIG_DIR`) and `~/.local/bin`, and `--skip-claude` (install, diff, doctor) does not run `claude`.
- Exit codes: 0 ok, 1 problems found, 2 usage error (also when Node is older than 22, before any command runs).

## Files and folders

```text
~/.claude/                          (or CLAUDE_CONFIG_DIR)
  rules/wf-house-rules.md           the house rules, global on purpose
  ai-agents-setup/                  the install folder, not your clone
    manifest.json                   what wf installed: hashes, versions, your tier, agent, model and skill choices
    wf-settings.json                allow mcp__wf__compact, deny Agent(model:*), Agent(effort:*) and unused tools, outputStyle Concise, ultracode off, wf sessions only
    local.json                      optional and yours: {"nodePath": "<node for the hooks>"}
    plugin/
      .claude-plugin/plugin.json    the plugin wf 2.1.1
      agents/                       the agent files you chose (32 with everything), skills inlined
      library/                      the 16 skills, read on demand
      hooks/                        hooks.json, guard.mjs, git.mjs, context.mjs, compact.mjs (the compaction module), title.mjs (the session naming hook), config.json
      bin/                          wf-agents, wf-clean, wf-keepwarm
      scripts/                      the node scripts behind them
    state/                          context ledgers (7 days), hook-errors.log
    backups/<UTC stamp>/            backup sets, the last 5 kept, plus the ones that hold your v1 install
    adopted/                        v1 originals, kept for uninstall and restore
~/.local/bin/wf                     the launcher (plus wf.cmd on Windows)
<project>/.work/                    task folders, only while a task runs
```

The hooks and the bin commands run with an absolute node path, the node that ran install, or `nodePath` from `local.json`.

## Troubleshooting

Start with doctor, from your clone folder. Each line is `ok`, `warn`, `fail` or `skip`, and a failing line says what to do:

```
node wf.mjs doctor
```

- `Claude Code 2.1.x is older than 2.1.312. Run: claude update`: update, then rerun install.
- `manifest files: N of 103 differ` (107 on Windows; fewer files when you left something out): something changed an installed file; rerun install, which repairs it.
- `fail hook self-test missing .../hooks/compact.mjs`: your install is older than your clone, because a `git pull` brought the compaction module and it is not installed yet. Rerun install.
- `warn choices ... git is new: node wf.mjs install adds it` (or `debugger is new: node wf.mjs install adds it`, or both as `debugger, git are new: ... adds them`; an install from before the installer choices shows it after `no saved choices;`): your install is older than that agent; rerun install, where the agents step shows it ticked.
- Something broke right after an install or uninstall: `node wf.mjs restore` puts back the state from before it. To pick another set, `node wf.mjs restore --to <stamp>`; an unknown stamp lists the available ones.
- `install failed after the backup`: the message says either that everything was put back already, or which `restore --to <stamp>` to run.
- `cannot install: ... Nothing was written.`: a planned write failed its check before the backup, so nothing changed. Fix the cause it names, then rerun install.
- The nvm warning, `the hooks will run ... a node of a version manager`: the hooks keep the absolute path of the node that ran install. With nvm, fnm, asdf, volta, mise, nodenv or n that version can disappear, and then the hooks stop working: the guard, which fails closed, blocks every git or gh Bash command and every Monitor call, and the context notices stop (doctor shows `hook node` fail). Use a node that stays (for example `brew install node`, then run install with it from your clone folder: `/opt/homebrew/bin/node wf.mjs install`, on an Intel Mac `/usr/local/bin/node wf.mjs install`), or write `{"nodePath": "/absolute/path/to/node"}` into `~/.claude/ai-agents-setup/local.json` (the shape of `local.example.json` in the clone) and rerun install. Install refuses a `nodePath` that is not node 22 or newer.
- The PATH hint, `<folder> is not on PATH. Add it: ...`: run the `echo ... >> <file>` command it shows (it appends one `export PATH=...` line to your shell's startup file), open a new terminal, and check with `command -v wf`.
- `Cancelled: nothing was written.` (esc in any list, or Cancel on the summary): nothing changed; run install again when you are ready.
- Broken boxes, icons or colors in the installer: on macOS and Linux, `NO_COLOR=1 node wf.mjs install` turns only the colors off, and this one asks the same five steps with ASCII icons and no colors, as numbered questions (type the numbers to toggle, then press enter to accept):

```
TERM=dumb node wf.mjs install
```

- A task runs at another tier than you expected, a coder writes the plan or does the review, a repeated failure gets another coder round instead of the debugger, or nothing is committed although you asked for a commit: that tier or agent is not installed (doctor's `choices` line names what is missing). Install again and tick it to bring it back. With the debugger installed, a repeated failure still gets a coder round once the debugger already ran for it or has run twice in the task; with the git agent installed, an approved commit can still be skipped or blocked, and the report's git line says why.
- A task got another tier than you expected although everything is installed: the tier follows difficulty and risk, not the number of files (see [How a task gets its tier](#how-a-task-gets-its-tier)). Start the request with `T0:`, `T1:`, `T2:`, `T3:`, `T4:` or `T5:` to force one.
- `wf guard: the orchestrator may not run "git ..."`: expected; the orchestrator runs read-only git only, and commits, pushes and pull requests go through `wf:git` when the approved summary asks for them.
- A wf task stopped half way: start `wf` in that project again and answer the Resume, Discard or Leave it question. The question comes at your first message only when the session that ran the task has been inactive for at least 75 minutes; until then the task counts as still running and is left alone, so start `wf` again later.
- A `wf context:` or `wf keep-warm:` line in a session is normal wf housekeeping, not an error, and so is a message that starts with `wf compaction done`: it comes from the plugin, not from you, and approves nothing (see [How the orchestrator compacts itself](#how-the-orchestrator-compacts-itself)).

Windows notes:
- Install Node with `winget install --id OpenJS.NodeJS.LTS -e` and Claude Code with the native installer in PowerShell (`irm https://claude.ai/install.ps1 | iex`). An npm `claude.cmd` shim is refused: install the native one, or set `WF_CLAUDE_BIN` to a `claude.exe`.
- Paths: the install folder is `%USERPROFILE%\.claude\ai-agents-setup`, the launcher folder `%USERPROFILE%\.local\bin`. The PATH hint is a PowerShell line that adds the launcher folder to your user PATH: run it, open a new terminal, and check with `Get-Command wf.cmd`.
- In PowerShell and cmd type `wf.cmd`: plain `wf` opens Windows' own `WF.msc` (the firewall console), which comes first on PATH. Git Bash keeps `wf`.
- On Windows the guard also checks PowerShell commands, and the bin commands get `.cmd` wrappers.

Linux notes: distribution Node packages are often too old; NodeSource has current ones (`wf.mjs` prints the steps when Node is too old). Claude Code: the native installer, `curl -fsSL https://claude.ai/install.sh | bash`.

## Development

From your clone folder:

```
npm test
```

```
npm run lint
```

`npm test` runs the `node:test` suite: no network, no dependencies, and no real `~/.claude` (every install test uses temporary folders). `npm run lint` is `node wf.mjs lint --self`: the source lint plus the house rules over the repository (no comments in `.mjs` and `.js` except TODO, no U+2012 to U+2015 in text files, LF line endings, no BOM). CI runs both on Ubuntu and macOS with Node 22 and 24. A separate CodeQL workflow (`.github/workflows/codeql.yml`) scans the JavaScript on every push and pull request to main, and weekly.

The visual guide is `docs/guide/wf-guide.html`: open it in a browser.

A sandbox install that never touches your real config (both paths absolute, in a scratch folder of your choice):

```
node wf.mjs install --config-dir /tmp/wf-sandbox/config --launcher-dir /tmp/wf-sandbox/bin --skip-claude --yes
```

Repository layout:
```text
wf.mjs                 entry point: checks Node 22+, then runs lib/main.mjs
registry.json          roles, tiers, models, context numbers, launcher env, plugin data
lib/                   the installer: main, core, compile, skills, select, prompt, ui, apply, migrate, doctor, lint, claude
personas/              the eight role bodies: orchestrator, planner, docs, coder, tester, reviewer, debugger, git
prompts/               worker.md (shared worker rules, reply style and result format), house-rules.md
skills/                the 16 skills
hooks/                 guard.mjs, git.mjs (the shell parser), context.mjs, compact.mjs (the compaction module), title.mjs (the session naming hook)
scripts/               wf-agents, wf-clean, wf-keepwarm
test/                  the test suite and its fixtures
docs/                  PLAN.md (the v2 plan), decisions.md, PROGRESS.md, guide/wf-guide.html
local.example.json     the shape of local.json
.github/workflows/     ci.yml, codeql.yml
.github/CODEOWNERS     @Procisz owns every file
```

Code style: zero dependencies, Node 22+, ESM `.mjs`, English, no comments except TODO, no em or en dashes, LF. The plan is `docs/PLAN.md`, the decisions are in `docs/decisions.md` (v2 from D105), and v1 lives in git history (last v1 commit `5d1d6f3`).
