---
name: testing
description: Writing and running tests in any framework. Tests after the code, the project's conventions, behavior over implementation, one behavior per test, deterministic, edge cases and error paths, never a weakened assertion, flaky means a bug.
metadata:
  wf-required: [tester]
  wf-default: [coder, debugger]
---

# Testing

## Who does what

- Whoever writes new tests: expected values come from summary.md and plan.md, never from running the code and copying its output: a test that freezes a bug is worse than none.
- Tester: writes the new tests after the code exists.
- Coder: updates the existing tests the intended change breaks and runs the related tests. New tests are the tester's job when plan.md has a tests phase, unless the delegation says `Also yours: tests`: then the coder writes those Tests entries after its code, by the same rules as the tester, except that it fixes product code its tests show is wrong.
- A tester never changes production code. A test that fails because the code is wrong stays; the result lists it under Open issues with the test name, the input and expected versus actual.

## Follow the project

- Use the framework, runner, assertion style, file layout and naming the project already has (package.json scripts, test config, neighbouring tests). No new framework or dependency unless plan.md says so.
- Put tests where similar tests live; reuse existing helpers and fixtures.
- English test names; no comments in tests: the reason goes in the name or an assertion message.

## What to test

- Behavior through the public interface: return values, thrown errors, and effects others can observe (files written, output, calls to injected collaborators). Not private helpers, call order or internal state.
- One behavior per test, named as a sentence with its condition: `returns an empty list when the folder has no skills`, `refuses a path outside the root`.
- For each changed behavior: the main case, the edge cases (empty, zero, one, many, boundaries, null or undefined, unicode, very long input, duplicates) and the error paths (invalid input, missing file, network failure, timeout), asserting the specific error type or message.
- Assert the exact expected value (`deepEqual`, `toEqual`), not just truthiness or that a function was called.
- Every test must be able to fail: name the line of the change that, if wrong, would make it fail. A test that passes with the change reverted proves nothing.

## Deterministic

- No real network, clock, randomness, home folder or global config. Inject or fake them: fake timers with a fixed system time, a stubbed `fetch` or a local server on port 0, injected ids.
- Files: a fresh temp folder per test (`fs.mkdtempSync(path.join(os.tmpdir(), "app-"))`) removed afterwards with `fs.rmSync(dir, { recursive: true, force: true })`. Never touch real user files.
- No order dependence: each test builds its own state; mocks, env vars and globals are restored after each test.
- No sleeps to wait for async work: await the promise, advance fake timers or wait for the event.
- Flaky means a bug in the test or the code. Find the cause (shared state, real time, unordered output, a race); never hide it with retries or longer timeouts.

## Never weaken a test

- Never loosen an assertion, delete a failing test, add `skip`, raise a timeout or update a snapshot just to get green. When the approved behavior really changed the expected value, change it and say so in the result.
- Never leave `only` or another focus marker behind.

## Running

1. Run the tests you wrote or changed, plus the tests of the touched modules, with the project's command filtered to those files.
2. Tester: when they pass, run the full suite once. A failing test the change cannot reach (check its imports and fixtures) goes under Open issues as probably pre-existing, with its name; do not fix unrelated tests. Coder: stop after step 1; run the full suite only when the project has no narrower command, because the tester and the final verification run it.
3. Never watch mode: always a single run that exits.
4. Put each command and its pass or fail in the result's Checks lines; a failing one gets a fail line per failing test, with its first error line and its log (worker Result rules).
