# Source of the vendored Vitest reference

`SKILL.md` is ours. `references/` and `LICENSE` are vendored.

- Upstream: https://github.com/antfu/skills/tree/8886fe2d385d3644cbb47e46ae9cb1cf09307d3b/skills/vitest
- Repository: https://github.com/antfu/skills
- Pinned commit: `8886fe2d385d3644cbb47e46ae9cb1cf09307d3b` (committed 2026-10-23)
- Upstream generation (from its `GENERATION.md`): built from vitest-dev/vitest at `a5022655de04ec3581026dac16b11251e4b6d40d`, Vitest 5.1.0-beta.1, generated 2026-10-23
- License: MIT, Copyright (c) 2025-PRESENT Anthony Fu, see `LICENSE` (upstream `LICENSE.md`)
- Vendored: 2026-10-28

## Files

| Local | Upstream |
|---|---|
| `references/<name>.md` (19 files) | `skills/vitest/references/<name>.md`, same names |
| `references/index.md` | `skills/vitest/SKILL.md` |
| `LICENSE` | `LICENSE.md` at the repository root |

Not vendored: `skills/vitest/GENERATION.md` (its facts are above). No scripts.

## Local changes

1. Every em dash (U+2014) was replaced, 63 in total, one per line: 59 by a colon and 4 by a comma. No en dash, figure dash or horizontal bar was present.
   - Commas: `references/core-config.md` line 131, `references/core-expect.md` line 89, `references/features-mocking.md` lines 97 and 300.
   - Colons, per file: advanced-environments 1, advanced-projects 3, advanced-type-testing 1, advanced-vi 2, core-cli 1, core-config 12, core-describe 1, core-expect 2, core-hooks 1, core-test-api 2, features-benchmarking 2, features-concurrency 1, features-context 14, features-coverage 5, features-mocking 5, features-reporters 4, features-snapshots 1, features-test-tags 1.
2. `references/index.md`: the upstream `SKILL.md` frontmatter was removed so the file is never read as a skill, the heading `# Vitest reference index` was added, and the links `references/<name>.md` became `<name>.md` because the file now sits in `references/`.
3. Line endings normalized to LF (upstream already used LF).

Nothing else changed. The upstream text installs packages only as local devDependencies (`npm i -D ...`, `yarn add -D vite`); nothing installs globally or fetches remote code. `references/features-concurrency.md` keeps a GitHub Actions expression with double braces (`matrix.shard`): it is upstream example code, not a wf placeholder. The comment directives in `references/` (`@vitest-environment`, coverage ignore hints, `@module-tag`, `@ts-expect-error`) stay as upstream wrote them; `SKILL.md` limits their use under the house rules.
