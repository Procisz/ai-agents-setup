---
name: javascript
description: Modern JavaScript for Node 22+ and browsers. ESM, ES2024+ idioms, errors with cause, validation at boundaries, async patterns, immutability, small pure functions, security, performance and zero dependencies, under the owner's house rules.
metadata:
  wf-required: []
  wf-default: [planner, coder, tester, reviewer, debugger]
---

# JavaScript

The project wins: its lint and format config, module style, naming and layout come first. These rules fill the gaps.

## House rules

- English identifiers, messages, log output and test names. Hungarian appears only as data (i18n dictionaries and the user-facing strings in them).
- No comments in code or tests; the only allowed marker is `TODO`. The reason goes in a name, an error message or the docs.
- Never an em dash or en dash (U+2014, U+2013) in code, strings or tests: use a comma, colon or hyphen.
- LF line endings, UTF-8 without BOM.

## Modules and runtime

- ESM only (`.mjs` or `"type": "module"`), no `require`. Builtins with the `node:` prefix: `import { readFile } from "node:fs/promises"`.
- Node 22 is the floor: global `fetch`, `structuredClone`, `AbortSignal.timeout()`, `AbortSignal.any()`, `util.parseArgs`, `util.styleText`, `import.meta.dirname`, `import.meta.filename`, top-level `await`, `node --test`, `--env-file`.
- Use what Node 22 has: `toSorted`, `toReversed`, `toSpliced`, `with`, `findLast`, `Object.groupBy`, `Map.groupBy`, `Promise.withResolvers`, `Array.fromAsync`, Set methods (`union`, `intersection`, `difference`, `isSubsetOf`), iterator helpers (`map.values().filter(f).toArray()`), the RegExp `v` flag.
- `Promise.try`, `RegExp.escape`, `using` declarations and `Error.isError` need Node 24: use them only when `engines.node` or the browser targets allow.
- Paths with `path.join` and `path.resolve`, never string concatenation. Module-relative files: `path.join(import.meta.dirname, "data.json")`.
- CLIs end with `process.exitCode = 1` and a return, so output flushes; `process.exit()` only after all output is written.

## Errors

- Throw `Error` objects or subclasses, never strings. Give failures callers branch on a `code`: `Object.assign(new Error("Config is not valid JSON"), { code: "CONFIG_PARSE" })`.
- Rethrow with the original as `cause`:

```js
try {
  return JSON.parse(text);
} catch (error) {
  throw new Error(`Cannot parse ${file}`, { cause: error });
}
```

- Never swallow errors. Ignore one expected case and rethrow the rest: `if (error.code !== "ENOENT") throw error;`.
- Messages name what failed and the input: `Unknown role "codr", expected one of: coder, tester`. No secrets in messages.
- Catch at the boundary (CLI entry, request handler, hook main) and turn the error into an exit code, a response or one log line; inner code lets errors propagate.

## Validation at boundaries

- Validate once where data enters: CLI args, env vars, files, JSON, HTTP bodies, query strings, `postMessage`, `localStorage`. Inside, trust the validated shape.
- Check presence, type, range and allowed values; fail with a clear message instead of silently defaulting a wrong value.
- Parsed JSON is untrusted: check it is a plain object before reading fields; never copy keys `__proto__`, `constructor` or `prototype`; key lookups by user input go in a `Map` or `Object.create(null)`.
- `Number.isInteger` and `Number.isFinite` over `isNaN`; `parseInt` always with a radix; money in integer minor units.

## Async

- Every promise is awaited, returned or collected. No `async` callback in `forEach`: use `for...of` (sequential) or `await Promise.all(items.map(fn))` (parallel).
- `Promise.all` for independent work, `Promise.allSettled` when partial failure is fine; bound concurrency for large lists instead of starting thousands of requests.
- Timeouts and cancellation through `AbortSignal`: `fetch(url, { signal: AbortSignal.timeout(10_000) })`, and pass `signal` down.
- `fetch` does not throw on HTTP errors: check `response.ok` and put `response.status` in the error.
- Sleep with `setTimeout` from `node:timers/promises`; wrap callback APIs with `util.promisify` or `Promise.withResolvers`.
- Streams with `pipeline` from `node:stream/promises` and `for await`; large text files line by line with `readline`.

## Shape of the code

- `const` by default, `let` only when reassigned, never `var`.
- Immutability by default: do not mutate arguments or shared state; return new values with spread, `toSorted`, `with`, `structuredClone`; `Object.freeze` exported constant tables.
- Small pure functions for the logic; IO (fs, network, clock, randomness, env) at the edges and passed in, which also makes tests easy.
- Early returns over nesting; an options object over boolean flag parameters; named exports.
- `===` always; `??` for defaults (keeps `0` and `""`), `?.` for optional access, `Object.hasOwn`, `.at(-1)`.
- Times stored and compared in UTC (ISO 8601 or epoch ms); shown with `Intl.DateTimeFormat` and an explicit `timeZone`. Numbers for people with `Intl.NumberFormat`.

## Security

- No `eval`, `new Function`, string `setTimeout` or `vm` on untrusted input.
- DOM: untrusted text through `textContent`, `setAttribute` or `createElement`; never `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`. No inline `on*` handlers; `addEventListener`.
- URLs: build with `new URL(input, base)` and `URLSearchParams`; encode path segments with `encodeURIComponent`. Before an untrusted URL reaches `href`, `src`, `fetch` or a redirect, allowlist `url.protocol` (`https:`, `http:`), and for server-side requests the host too.
- Paths from input stay inside a root:

```js
const target = path.resolve(root, input);
const rel = path.relative(root, target);
if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes the root: ${input}`);
```

- Child processes: `execFile` or `spawn` with an argument array and no shell; never a shell string built from input. On Windows `.cmd` and `.bat` need `shell: true`, so quote every argument.
- Secrets from env or a secret store, never in source, URLs, logs or errors. Compare tokens with `crypto.timingSafeEqual`; ids from `crypto.randomUUID()`, never `Math.random()`.
- Regexes on untrusted input: no nested quantifiers like `(a+)+`, cap the input length first.
- Replace files atomically (write a temp file in the same folder, then `rename`); delete only paths your code created, never with a glob or a path built from input.

## Performance basics

- Lookups inside loops through a `Map` or `Set` built once, not `find` or `includes` per item.
- No `await` in a loop for independent work; no sync fs in servers or hot paths (fine in CLIs, installers and tests).
- Stream or paginate unbounded data instead of loading it whole.
- Hoist constant regexes and `Intl` formatters out of loops.
- Measure before optimizing (`performance.now()`, `node --cpu-prof`); keep the simple version unless numbers say otherwise.
- Browser: `<script type="module">` (deferred by default), batch DOM writes, no layout reads (`offsetHeight`) between writes, event delegation, lazy-load what the first view does not need.

## Zero dependencies

- The platform first: `node:test` with `node:assert/strict`, `util.parseArgs`, `fetch`, `fs.cp`, `fs.rm({ recursive: true })`, `fs.mkdtemp`, `crypto`, `readline/promises`, `util.styleText`, `Intl`, `structuredClone`.
- Add a dependency only when plan.md or the user allows it, pinned in package.json and the lockfile. Never install anything globally.
