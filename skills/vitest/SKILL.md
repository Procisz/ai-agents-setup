---
name: vitest
description: Vitest 5 best practice for writing and running tests. Structure, vi.fn, vi.spyOn, vi.mock with vi.hoisted, restoring mocks, fake timers, test.each, environments, vitest run, v8 coverage, inline snapshots, async assertions, plus the vendored API reference.
metadata:
  wf-required: []
  wf-default: [tester]
---

# Vitest 5

The owner's projects use `vitest` ^5.0.1. Check the installed version (package.json, lockfile) before using anything the reference marks 5.1. The reference files are listed at the end; Read one only when you need it.

## Running (agents and CI)

- Always one run that exits: `npx --no vitest run`. Never plain `vitest` or `vitest watch`: in a terminal they start watch mode and never return. For the full suite prefer the project's script; if it is plain `vitest`, use `npm test -- --run`.
- Only the project's installed vitest: if `node_modules/.bin/vitest` is missing (not installed, even when devDependencies lists it), report that instead of running it. Always write `npx --no vitest`: without `--no`, npx downloads and runs the latest vitest from the registry when none is installed.
- Related tests first: a file `npx --no vitest run src/parse.test.ts`, a name `npx --no vitest run -t "parse > rejects"` (v5 matches the `>`-joined full name), a source file `npx --no vitest related src/parse.ts --run`, a project `--project unit`. Then, as the tester, the full suite once; a coder stops at the related tests.
- Vitest picks the compact `minimal` reporter (alias `agent`) when it detects a coding agent; keep it. In v5 the `json` and `junit` reporters write under `.vitest/`, not stdout.

## Structure

```js
import { describe, it, expect } from "vitest";
import { parseRole } from "./roles.js";

describe("parseRole", () => {
  it("returns the role for a known name", () => {
    expect(parseRole("coder")).toEqual({ name: "coder", tier: 1 });
  });

  it("throws for an unknown name", () => {
    expect(() => parseRole("codr")).toThrow(/unknown role "codr"/i);
  });
});
```

- Import the API from `vitest` unless the config sets `globals: true` and the project relies on it.
- One `describe` per unit, one `it` per behavior, English names that read as a sentence. Fresh state in `beforeEach`; nothing mutable shared across tests.

## Mocks

- `vi.fn(impl)` for injected collaborators; `vi.spyOn(object, "method")` to watch or replace a method of a real object. Assert outcomes first, calls second: `expect(send).toHaveBeenCalledWith("a@b.c", expect.any(String))`.
- Prefer injecting a dependency over mocking a module.
- `vi.mock` is hoisted above the imports, so its factory cannot use the file's variables. Create them with `vi.hoisted`:

```js
const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock(import("./db.js"), () => ({ getUser }));
```

- In v5 `vi.mock`, `vi.unmock` and `vi.hoisted` throw inside a function, `describe` or test: keep them at the top level. Per-test module mocks: `vi.doMock`, then `await import()`.
- Partial mock: `vi.mock(import("./util.js"), async (importOriginal) => ({ ...(await importOriginal()), now: vi.fn() }))`. Real code with call tracking: `vi.mock("./calc.js", { spy: true })`.

## Restoring

- v5 defaults to `clearMocks: true`: call history is cleared before each test, implementations stay.
- Restore spies after each test: `restoreMocks: true` in the config (plus `unstubEnvs: true` and `unstubGlobals: true` when tests use `vi.stubEnv` or `vi.stubGlobal`), or `afterEach(() => { vi.restoreAllMocks(); })`.
- `restoreAllMocks` restores only `vi.spyOn` spies; reset `vi.fn` implementations with `mockReset()` or `mockReset: true`. On Node 24+ `using spy = vi.spyOn(...)` restores at the end of the block.

## Fake timers and dates

```js
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T09:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

it("expires the session after 30 minutes", async () => {
  const session = startSession();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(session.expired).toBe(true);
});
```

- Use the `Async` timer methods when the code awaits promises between timers. For `setInterval` advance by time or `vi.runOnlyPendingTimers()`, not `vi.runAllTimers()`.
- v5 fakes `Temporal` together with `Date` when it exists.

## Parameterized tests

```js
it.for([
  { input: "", expected: [] },
  { input: "a,b", expected: ["a", "b"] },
])("splits $input", ({ input, expected }) => {
  expect(split(input)).toEqual(expected);
});
```

`test.each` spreads array rows into arguments; `test.for` does not and passes the test context second. In v5 a `$` interpolated string is no longer quoted in the title.

## Environments

- Default `node`. DOM tests use `jsdom` (most complete) or `happy-dom` (faster), added as a devDependency only when plan.md allows.
- Per file through the config: a `projects` entry with `include` globs and `environment: "jsdom"`.
- The comment directives the references show (`// @vitest-environment`, `/* v8 ignore */` and `/* istanbul ignore */` hints, the JSDoc `@module-tag`, `// @ts-expect-error`) are comments under the house rules. Prefer the config (`projects` with `environment`, `coverage.exclude`) or the `tags` option. Use a directive only where the project already uses that same directive, and never put explanatory text after it.

## Coverage

- `npx --no vitest run --coverage` with `coverage.provider: "v8"` (the default) and `@vitest/coverage-v8` at vitest's version.
- Since v4 only files the tests load are reported unless `coverage.include` is set (`coverage.all` is gone): set `include: ["src/**"]` for honest numbers.
- Do not add or raise thresholds unless plan.md asks. Coverage finds untested code; it is not the goal.

## Snapshots

- Only small, stable, deterministic output; prefer `toMatchInlineSnapshot()` so the expected value sits in the test.
- No timestamps, random ids or absolute paths: normalize them or use property matchers, `toMatchSnapshot({ id: expect.any(String) })`.
- Never run `-u` to make a failure go away; read the diff and accept only intended changes.

## Async assertions

- `await expect(load("x")).resolves.toEqual({ id: "x" })`, `await expect(load("")).rejects.toThrow(/empty id/)`. v5 fails a test that leaves `resolves` or `rejects` unawaited.
- Sync throws: `expect(() => parse("{")).toThrow(SyntaxError)`.
- Eventual state: `await vi.waitFor(() => expect(spy).toHaveBeenCalled())` or `await expect.poll(() => queue.size).toBe(3)`; never sleeps.

## v5 config facts

Node 22.12+ and Vite 6.4+; default pool `forks`; `workspace` became `projects`; `poolOptions`, `test.sequential` and `describe.sequential` are gone (use `{ concurrent: false }`); no config lookup in parent folders; artifacts in `.vitest/` (git-ignore it).

## Reference (Vitest 5.1 docs, vendored from antfu/skills)

- {{skillDir}}/references/index.md: overview and topic table
- {{skillDir}}/references/core-config.md: config file, options, v4 and v5 changes
- {{skillDir}}/references/core-cli.md: commands and flags
- {{skillDir}}/references/core-test-api.md: test, modifiers, test.each, test.for
- {{skillDir}}/references/core-describe.md: describe and suites
- {{skillDir}}/references/core-expect.md: matchers, asymmetric matchers, expect.soft, expect.poll
- {{skillDir}}/references/core-hooks.md: beforeEach, afterEach, aroundEach
- {{skillDir}}/references/features-mocking.md: vi.fn, vi.mock, vi.when, timers, dates, globals
- {{skillDir}}/references/features-snapshots.md: file and inline snapshots
- {{skillDir}}/references/features-coverage.md: v8 and Istanbul coverage, thresholds
- {{skillDir}}/references/features-context.md: test context and fixtures, test.extend
- {{skillDir}}/references/features-concurrency.md: concurrent tests, pools, sharding
- {{skillDir}}/references/features-filtering.md: filtering by file, name, changes, last run
- {{skillDir}}/references/features-test-tags.md: test tags
- {{skillDir}}/references/features-reporters.md: reporters and output files
- {{skillDir}}/references/features-benchmarking.md: the bench fixture
- {{skillDir}}/references/advanced-vi.md: every vi utility
- {{skillDir}}/references/advanced-environments.md: node, jsdom, happy-dom, custom environments
- {{skillDir}}/references/advanced-type-testing.md: expectTypeOf and assertType
- {{skillDir}}/references/advanced-projects.md: projects and per-project config
