# Changelog

## Unreleased

### Added

- A pre-commit hook (`.githooks/pre-commit`) runs `npm run lint` and `npm test` and blocks em or en dashes in added lines, conflict markers and `.work/` files. A successful `node wf.mjs install` enables it by setting `core.hooksPath` to `.githooks` in a git clone.

## 2.1.2 - 2026-11-12

### Added

- A CODEOWNERS file (`.github/CODEOWNERS`) makes @Procisz the code owner of every file.
- A CodeQL scanning workflow (`.github/workflows/codeql.yml`) scans the JavaScript on every push and pull request to main, and weekly.

## 2.1.1 - 2026-11-11

### Changed

- wf sessions never use fast mode, for any model: the launcher sets `CLAUDE_CODE_DISABLE_FAST_MODE=1`.

## 2.1.0 - 2026-11-11

### Changed

- The planner at T1 and the git agent (`wf:git`) run on Haiku 5.5 with medium effort instead of high (decision D140).
- The keep-warm watcher finds every subagent of the session by itself and keeps them warm: 5 minute agents every 4 idle minutes up to 30 minutes after their last work, the main thread and 1 hour agents at 58 minutes (decision D141). The orchestrator no longer passes an agent list; `--agents` is still accepted.
