---
name: final-report
description: How the wf orchestrator ends a task. The git phase through wf:git when the summary asks, then stopping everything, the short plain report (done, changed files, checks, assumptions, not done, git) and wf-clean.
metadata:
  wf-required: [orchestrator]
  wf-default: []
---

# Final report

It ends every T1 to T5 task, also one that stopped early.

## The git phase

Only when the approved summary's Git line asks for any git work, or says no git agent is installed. You run read-only git only; `wf:git` does every write.
1. Compare `git rev-parse HEAD`, `git for-each-ref | cksum` and `git stash list | wc -l` with the baseline in progress.md. When one moved, someone committed, moved a ref or stashed during the task: no git round; the git line says so.
2. Compare `git status --porcelain` with the baseline. Write `<task folder>/notes/git.md`:
   - `Git:` the summary's Git line;
   - `Branch:` a branch name or base the user gave, or none;
   - `Stage:` the workers' Changed files that had no changes at the baseline, one per line, never `.work/`;
   - `Leave unstaged:` every other entry new since the baseline (someone else's edits, output of the checks), and files that already had changes at the baseline;
   - `Checks:` the last result of each check; `Open issues:` the open issues, for the pull request body.
3. No git agent installed: no git round; the git line lists the commands for the Stage paths and the `asked:` part of the Git line. Otherwise start `wf:git` with `Package: all`, `Read first: summary.md, notes/git.md` and `Goal: <the Git line>`, and print `wf: git: started`. Its Branch, Commits, Push, Pull request and Other actions lines go to the git line. Any blocked result (a refusal, a failed hook or push, a secret-check hit, a missing remote or gh login) goes under Not done or failed with its reason and the commands under its Open issues. It is final: never resume or restart `wf:git` on your own decision, never work around it and never run a git write yourself.

## Before the report

1. Nothing may keep running. Wait for workers still running, or TaskStop them when the task stops early. Stop the keep-warm watcher with TaskStop (its id is in progress.md).
2. Collect from progress.md and the workers' results:
   - what was done;
   - the changed files: the workers' Changed files, never `.work/`;
   - the files left unstaged at the git phase, or, without one, the other `git status --porcelain` entries new since the baseline: they go under Not done or failed as `changed during the task, not by wf, left unstaged: <paths>`;
   - whether HEAD, the refs or the stash count moved since the baseline other than by `wf:git` (step 1 of the git phase, or now when there was none);
   - the last result of each check, and whether that run came after the last code change;
   - every assumption and every open issue (a `Waiting request:` goes under Follow-ups as `Waiting: <it>`, not under Not done or failed);
   - from summary.md: the Tier line when the task ran as another tier because its own is not installed, the Review line when a coder reviewed because no reviewer is installed, and the Git line when no git agent is installed;
   - findings and failures left after the fix rounds;
   - for each failure marked reported under Failures after a debugger run: its signature and the debugger's Root cause line (or its best hypothesis); a failure marked fixed after the debugger is not listed there, but an open issue about it (may be flaky) is.
3. Run `wf-clean <abs task folder>`. It deletes the task folder, and `.work/` too when nothing else is left in it. A refusal goes under Not done or failed.
4. Print `wf: report: done` (or `wf: report: stopped early`), then the report as your last message.

## The report

Plain words, at most about 25 lines, no file contents, no internal ids:

```
✅ **Done**
<1 to 5 lines: what now works, in the words of the summary>

📁 **Changed files**
<paths, one per line or comma separated; grouped by folder when there are many>

🧪 **Checks**
✅ <command>: pass
❌ <command>: fail (<one-line reason>)
⏳ <command>: not rerun after the last fix (was pass)

💡 **Assumptions**
- <each decision made without asking>, or: none

🚧 **Not done or failed**
- <open issues, failing checks, findings left after 2 fix rounds, unstaged files>, or: nothing
- <failure>: still failing after the debugger; root cause: <its Root cause line, in plain words>

🔜 **Follow-ups**
- <suggested next steps>, or: none

🧩 **Setup**: <only when something was missing, for example: ran as T4 (T5 is not installed); review by a coder (no reviewer is installed); not committed (no git agent is installed)>

<git line, starting with 🌿 >
```

Leave out the Setup line when nothing was missing.

The git line is one of:
- `Committed on <branch>: <short hash> <subject>`, plus `, pushed to <remote>/<branch>` after a push, `, pull request <url>` after one was opened and `, merged` after a merge, then `; <its Other actions line>` when it did more;
- `Git: <its Other actions line>` when the Git line asked for git work without a commit;
- `Not committed: <reason>` when the summary asked for a commit that did not happen; `Pull request not opened: <reason>` when it failed;
- `HEAD or refs moved during the task: <old>..<new>; wf did not commit` when step 1 of the git phase found a commit, ref change or stash that wf did not make;
- `Not committed: no git agent is installed. To do it yourself:` followed by the commands for the Git line's `asked:` part, one per line: `git switch -c <the branch name it gives, else a <type>/<slug> name>`, `git add -- <the Stage paths>`, `git commit -m "<subject>"`; only when it says push or pull request also `git push -u origin <branch>` and `gh pr create --fill` (with `--base <base>` when it names a base); only when it says merge also `gh pr merge --merge`; for any other action the git or gh command that does it (for example `git branch -d <branch>`, `git push origin --delete <branch>`);
- `Nothing was committed: review the changes in your working tree.`, only when the summary asked for no git and HEAD, the refs and the stashes match the baseline.

## Rules

- Keep every assumption; merge two only when they say the same thing.
- Say plainly what failed or was left out; never call a failing or skipped check a pass, and never show a pass from before the last code change as the final result.
- A check that already failed before the task is named as such, not as a task failure.
- When the report would pass 25 lines, shorten Done and group Changed files; never drop an assumption, a failure, the Setup line or the git commands.
