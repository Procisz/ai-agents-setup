---
name: debugging
description: Finding and fixing the root cause of a failure. Reproduce with the exact command, isolate, test one hypothesis at a time, check assumptions, fix the cause not the symptom, verify with the original command and its neighbours, remove instrumentation, record the root cause; common traps.
metadata:
  wf-required: [debugger]
  wf-default: []
---

# Debugging

A fix without a known cause is a guess. Each step leaves evidence you can name: a command and its output, or a file, line and value.

## 1. Reproduce

- Run the exact failing command, from the same folder, with the same environment. Send long output to a file in the task's notes/ and read the first error and the tail, not only the last line.
- Write down what you saw: exit code, the first error, expected and actual values.
- Once it fails, narrow the run to the single failing test (a name filter or one file) and confirm it fails the same way. Iterate on the narrow run; it is faster.
- It does not fail: run it 3 times and go through the traps (below) before you call it flaky. Record each run.

## 2. Isolate

- Read the whole error: message, stack, the first frame in project code and every "caused by". The first error is usually the cause; later ones follow from it.
- What changed: `git diff --stat`, then `git diff -- <file>` for the task's files. `git log --oneline -5 -- <file>` and `git log -S'<text>' --oneline` show when a line appeared. Git stays read-only.
- Shrink the input: halve the data, the test or the config until the failure goes away; the last part removed is involved.
- Minimal repro: a few lines in notes/ (for example `node <task>/notes/repro.mjs`) that call the code directly and print the wrong value.
- Follow the wrong value backwards, from where it is observed to where it is produced, and read every function on that path.

## 3. One hypothesis at a time

- Write it as a sentence that can be false: "total is NaN because parsePrice returns undefined for an empty string".
- Choose a check that tells it apart: one printed value, one assertion, one changed input. Predict the result before you run it.
- Confirmed: go on. Refuted: note it as ruled out, then form the next one. Never change two things at once.
- After 3 refuted hypotheses, go back to step 2: your picture of the code path is wrong.

## 4. Check assumptions

Verify, never assume:
- versions: `node -v`, the installed version of the package involved (its package.json under node_modules), the binary that really runs (`command -v <tool>`);
- environment: env vars, cwd, TZ, locale, platform, PATH;
- configuration: which config file is really loaded, its precedence and defaults;
- data: the real input (print it), encoding, line endings, empty, null and missing values, order.

## 5. Fix the cause

- Fix where the wrong value is produced, not where it shows. A catch, a default or a retry around the symptom hides the bug.
- Make the smallest change that removes the cause; no refactor around it.
- Never weaken a test or a check to make it pass: no skip or only marker, no looser assertion, no longer timeout, no changed threshold or config. A test that is really wrong is corrected to assert the right behavior just as strictly.
- When code that an earlier attempt at this failure added does not help, and your input lists that attempt (in wf: notes/debug-<n>.md), remove that code with an edit. Never remove a change your input does not list as an attempt: it may be the user's or another worker's. Never restore files through git.

## 6. Verify

- Rerun the original failing command exactly, then its neighbours: the rest of that test file, the tests of every file you changed, lint and typecheck.
- A regression test must fail without the fix: undo the fix with an edit, run the test, see it fail, redo the fix, run it again.
- A timing or order suspect: run the test 5 times, and once inside the full file, before you call it fixed.

## 7. Clean up and record

- Remove every print, log line and temporary file you added to the project. `git diff` of your files shows only the fix and its test.
- Write the root cause in one line: file and line, what is wrong, why it produced the failure, and the evidence that proves it.

## Traps

- Flaky timing: sleeps, timeouts, real clocks and `Date.now`, races between async steps. Passes alone, fails in the suite: shared state or test order.
- Caching: build, transpiler and test runner caches, memoized modules, a stale install. Prove it with the tool's no-cache option before deleting anything.
- Stale builds: tests that run dist/ or build/ output older than the source; a generated file not regenerated.
- Wrong cwd: relative paths resolved from another folder; a workspace package run from the repository root.
- Environment differences: CI versus local, variables set only in your shell, case-insensitive file systems (macOS) versus Linux, Windows path separators, CRLF, timezone and locale.
- Async ordering: a missing await, an unhandled rejection, an event fired before its listener attaches, a callback that runs after the test ended.
- Mocks that bypass the real code path, or leak into the next test.
- Wrong module: two copies of a package, a shadowed name, an import that resolves to another file or version than you think.
