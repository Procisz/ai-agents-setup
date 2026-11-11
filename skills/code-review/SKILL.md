---
name: code-review
description: Reviewing one task's change against its approved summary and plan. Correctness, security, data loss, regressions, performance, tests and house rules; blocker, major or minor findings, each verified, with file and line and a one-line fix.
metadata:
  wf-required: [reviewer]
  wf-default: []
---

# Code review

You judge whether the change does what summary.md approved, safely. You never edit files. With no reviewer installed, a coder in a `Review only` round uses this skill the same way.

## Scope

- Only this task's change: the files the delegation or progress.md lists as changed. Get the diff with `git status --porcelain`, `git diff -- <files>` and `git diff --cached -- <files>`; read new untracked files in full.
- progress.md holds the `git status` from before the task. Changes already there are the user's own work: not findings, unless this change breaks them.
- Read the whole diff before judging. Open other files only to confirm or refute a finding (callers, types, tests, config).
- Do not rerun the full suite: the project's checks ran in the last worker round. Run a command only to verify a finding (one targeted test, a short `node -e` reproduction), never one that writes files or changes git state.

## Against the approval

1. Read summary.md and plan.md and list each approved behavior.
2. Find where the diff implements each one. Missing or contradicted approved behavior is a blocker.
3. Changes the summary does not need (extra features, unrelated refactors, reformatting, new dependencies) are scope findings.

## What to look for

- Correctness: wrong results; edge cases (empty, zero, one, many, null or undefined, boundaries, unicode, huge input, duplicates, time zones, concurrent calls); error paths that throw the wrong error, swallow it or leave partial state; off-by-one; a missing `await`, an unhandled rejection, a race.
- Security: injection (shell strings, SQL, `innerHTML`, `eval`); path traversal; untrusted URLs without a protocol or host check; secrets in code, logs, URLs or errors; missing validation at a trust boundary; missing authorization; prototype pollution.
- Data loss: deleting or overwriting user data, `rm` with a glob or a variable, non-atomic writes of important files, migrations with no backup or way back, truncated or re-encoded files.
- Regressions: callers of changed functions, exports, CLI flags, config keys, defaults, file formats and messages that others parse (grep for them); removed behavior; Windows paths and case-insensitive file systems.
- Performance: quadratic work on growing input, `await` or IO in loops over independent items, sync IO in servers, unbounded memory, missing pagination.
- Tests: each changed behavior has a test that would fail without the change; tests assert outcomes, not only calls; no weakened assertion, deleted test, `skip` or `only`; no real clock, network or home folder.
- House rules in added lines: English identifiers and messages, no comments except TODO, no em or en dash (U+2014, U+2013), LF.

No style nits: naming, formatting, preferred idioms and alternative designs are not findings unless they break a house rule or cause a bug.

## Verify every finding

Try to refute each candidate before reporting it:
- Trace the real code path and name the concrete input or state that fails, with expected versus actual.
- Look for what may already handle it: an upstream guard, a type, validation, a test, an assumption in plan.md.
- Confirm the line belongs to this change or is directly broken by it.

Report only confirmed findings. A suspicion you can neither confirm nor refute goes under Open issues as `unverified: <what and where>`, never as a finding with a severity.

## Severity

- blocker: approved behavior missing or broken, a security hole, data loss, a check failing because of the change.
- major: a realistic bug on a plausible input, missing error handling that matters, a regression for an existing caller, changed behavior with no test when the task had a tests phase, a house rule broken in added lines.
- minor: a real but unlikely bug, small scope creep, a missing edge-case test, an unclear error message.

Verdict: fail when there is a blocker or major finding, else pass.

## Output

The worker result of your instructions, with no extra fields: the verdict goes in Summary, the findings under Open issues.

```
Status: done
Summary: Reviewed 6 changed files against summary.md and plan.md. Verdict: fail (1 major, 1 minor).
Changed files: none
Checks: node --test test/paths.test.mjs: fail (reproduces the major finding)
Assumptions: none
Open issues:
- major lib/paths.mjs:42: input "../x" escapes the root. Evidence: it resolves outside the root, expected a refusal. Fix: refuse when path.relative(root, target) starts with "..".
- minor lib/cli.mjs:88: the missing --out error names no flag. Evidence: the message is "missing value". Fix: say that --out is required.
```

- One line per finding: severity, `path:line` (the line in the new file), the claim, `Evidence:` with an excerpt or the input with expected and actual, then `Fix:` and one line of direction, not code.
- Order by severity, then by path; `unverified:` lines come last. Write `Open issues: none` when nothing survived verification.
