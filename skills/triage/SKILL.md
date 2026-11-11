---
name: triage
description: The silent first step of every wf request. Scores difficulty and risk to pick the tier T0 to T5 (never by file count), picks the phases and the git wish, and handles T0 questions and tiny edits directly.
metadata:
  wf-required: [orchestrator]
  wf-default: []
---

# Triage

Run it on every new request, silently: say nothing about it. Its results appear in the summary (tier with its reason, phases, git).

## Look, cheaply

Read only what you need to understand the request: file names and a quick look, at most a few calls in one response. The planner explores later.
- list the project root and run `git status --porcelain` and `git branch --show-current` (no git repository: no git phase);
- read the scripts of the project manifest (package.json, Makefile, pyproject.toml, Cargo.toml, go.mod or similar);
- Glob for docs (`README*`, `docs/**`, `CHANGELOG*`) and tests (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, `*_test.*`);
- Grep for a name from the request only when the request is unclear without it.

Never read source files in full here.

## Tier

Difficulty and risk decide the tier, never the number of files: replacing one email address in 30 files is still a very small task.

An explicit prefix `T0:`, `T1:`, `T2:`, `T3:`, `T4:` or `T5:` wins. A question with no change wanted is T0: answer it (see T0), whatever its topic. Otherwise score the change on twelve factors, 0 to 2 each, total 0 to 24:

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

Total 0 to 2 and the request is an answer or one obvious edit: T0. Total 0 to 2 otherwise (for example the same edit across many files): T1. 3 to 6: T1. 7 to 10: T2. 11 to 14: T3. 15 to 19: T4. 20 to 24: T5.

Overrides, applied after the total:
- Risk 2 in the logic being changed: at least T2. A mechanical edit inside risky files does not count.
- The user asks for extra care: T5.

When unsure between two tiers, let the discussion settle it, else take the higher one. The planner may raise the tier after reading the code, never lower it; the orchestrator never lowers it after the approval.

Examples with their totals:
- T0: a typo (0); any question.
- T1: one email address replaced across 30 files (1, more than one obvious edit); a new CLI flag that only prints a value (about 6).
- T2: a new validation rule with its messages and tests in one module (about 8 to 10).
- T3: a new installer step across several modules, the saved manifest and the docs (about 14).
- T4: a migration that renames a column (about 16); a job queue with parallel workers, retries and a new stored format (about 19).
- T5: moving stored passwords to a new hashing scheme on live data (about 20); a payment flow change across services with a data migration (about 22).

Keep the reason for the summary's Tier line in a few words, from the factors that decided it, for example `T3: several modules, a stored format, needs new tests`.

### A tier that is not installed

T0 needs no agents and is always there. When Your installed setup in your instructions says T1, T2, T3, T4 or T5 is not installed, a task of that tier runs as the nearest installed tier, the higher one on a tie: a missing T3 runs as T4, or as T2 when T4 is missing too. This holds for a prefix, for a T0 edit that becomes T1 and for a later raise. The summary's Tier line says so, for example `T4: a T5-sized change (extra care asked); T5 is not installed, so it runs as T4`.

## Phases

- Plan and implementation: always (T1 to T5). The planner writes the plan at every tier.
- Docs: the project has docs that describe what changes (a README section, `docs/`, a changelog it keeps), or the user asked.
- Tests: the project has tests, or the user asked.
- Verification: the project has its own check commands (lint, typecheck, build).
- Review: only when the user asked for a review or a second opinion.
- Git: only when the user asked for git work (a commit, a push, a pull request, a merge, or any other git action such as deleting branches): the Git line names exactly that. Otherwise leave uncommitted. No git agent installed: leave uncommitted, but keep what was asked for the summary's Git line; the report lists the commands.

Keep a reason of a few plain words for each optional phase that runs; the summary shows it. A phase whose agent is not installed still runs; your instructions say who does it.

## T0

- A question: answer it directly and briefly. Read what you need with Grep and line ranges. No summary, no approval, no task folder, no agents. Change nothing, also when the answer finds something to fix (skill discussion, Before the approval).
- An answer that suggests changes never offers them in prose ("Should I...?", "I can do it right away"). It ends with one AskUserQuestion, multiSelect, whose question text starts with the gist of the answer in at most 3 lines, the first starting with `💡`, and one plain line per suggestion (text beside a tool call can go missing, the question is always shown), each starting with `🔧`, then `Which of these should I prepare as a task?`, at most 1,900 characters in all; options the suggestions (at most 2, most valuable first, grouped when there are more), each description saying what it would change, `None for now` and `Something else`. The full answer may also stand in the reply text. Picked suggestions, or a reply that asks for any of them ("ok", "yes", "do it"), are a new request, never an approval: triage it and go through the discussion, the summary and the approval question. Nothing changes before Approve.
- A tiny edit: the single approval question of skill discussion (Approve, Change something, Cancel, Something else), its question text a one-line summary (what changes, in plain words, naming the file when it is outside the project, for example `~/.claude/settings.json`, that nothing is committed, and the time, usually about 1 minute), then on its own line `Approve this edit? After that I make it and reply in one or two lines.`; do not print the summary as reply text. On Approve make the edit yourself, run the project's fast check for that file when there is one, and reply in one or two lines, the first starting with `✅`. No task folder, no agents, no keep-warm watcher. The request to make the edit is not its approval.
- Any git work wanted (a commit, push, pull request or another git action) with the git agent installed, or a T0 edit that turns out bigger or unclear: T1, go to the discussion.
- No git agent installed (Your installed setup): a git wish alone does not raise a T0 edit. Its one-line summary says nothing will be committed because no git agent is installed; after the edit the reply lists the commands: `git switch -c <branch>`, `git add -- <the file>`, `git commit -m "<subject>"`, and for a push or pull request `git push -u origin <branch>` and `gh pr create --fill`, and for another git action its git or gh command.

## Then

T1 to T5: go to the discussion with the tier and its reason, the phases and their reasons in mind.
