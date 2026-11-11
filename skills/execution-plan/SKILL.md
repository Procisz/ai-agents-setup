---
name: execution-plan
description: How to write plan.md for an approved wf task. Packages with files, steps, dependencies and parallel marks, plus docs, tests, check commands, library skills, risks and assumptions. The planner writes it at every tier; the orchestrator reads it.
metadata:
  wf-required: [orchestrator, planner]
  wf-default: []
---

# Execution plan

Write `<task folder>/plan.md` for an approved task. summary.md is the contract: plan exactly what it asks, keep what it says stays the same, never change summary.md. The plan says what to change where; it does not hold the code.

## Explore

- Glob and Grep first, then Read only the line ranges you need. Read-only Bash is fine (`ls`, `git log -- <path>`, `git ls-files`, the manifest's scripts).
- Find: the files to change or create; the conventions to follow (name an existing file to copy the style from); the docs that describe the changed behavior; the tests that cover it (existing tests the change will break, and where new tests belong); the project's own check commands exactly as they run (lint, typecheck, build, test, and a narrow form for one file or one test when the tool has one).
- Never read lockfiles, build output, minified, generated or vendored files in full.

## plan.md

```
# Plan: <title>
Goal: <one line, from summary.md>

## Packages
### P1: <name>
- Goal: <one line>
- Files: <paths to change or create>
- Steps:
  1. <concrete step: the function, key, message or behavior it touches>
  2. ...
- Depends on: none | P<n>
- Parallel: yes | no
- Skills: <library skill names to read, or none>
- Checks: <fast commands the coder runs for this package>

## Docs
- <file>: <what to update>, or: none (<reason>)

## Tests
- <test file>: <behaviors to cover>, framework <name>, or: none (<reason>)

## Checks
- <command>: <what it checks>, or: none

## Risks
- <risk, and the step that avoids it>, or: none

## Assumptions
- <each open choice you decided>, or: none
```

## Rules

- One package unless the work splits cleanly. `Parallel: yes` only when the package depends on no other open package and its files are disjoint from every other parallel package; at most 5 run at once.
- Size each package by the context its worker needs, never by its file count: one worker must finish it far below {{warnTokens}}, counting what it has to read and understand, not the files it touches. A mechanical edit across many files (a replace, a rename, a version bump) stays one package. Split only work that needs more understanding than that, into sequential packages.
- Existing tests that the intended change breaks go into the package's Steps: the coder updates them. New tests go under Tests, not into packages, when the tests phase runs; when it does not run, coders add no tests.
- No docs agent or no tester installed (your installed setup or the delegation says `Not installed: ...`): the coders do that work after their code. End each Docs or Tests entry of the missing role with ` (P<n>)`, the package whose change it describes. Each such file belongs to one package and counts among its files for the Parallel rule. Add docs-writing to the Skills line of a package that gets Docs entries this way, and testing to one that gets Tests entries.
- Fix every user-visible name, default and message the change adds (flags, options, outputs) in Steps or Assumptions: the docs agent writes around anything left open. When the project keeps a changelog and the docs phase runs, list it under Docs.
- Docs and Tests follow the phases of the approved summary. When the code shows docs that the summary left out but the change makes wrong, add them and say so under Assumptions. A phase the summary names keeps its section; write `none (<reason>)` when there is nothing for it to do.
- Checks lists only commands the project already has. Never plan to install tools or global packages. The last worker round runs them once at the end.
- Skills names the skills a package's worker should read, taken from the Skill library list in your instructions (for example javascript, testing, vitest). Names only.
- Plain markdown, no code beyond a short signature, at most about 150 lines (about 30 at T1).
- Decide open choices yourself and list them under Assumptions. Never ask the user.
- The tier: when the code shows the task scores higher than summary.md's Tier line (the twelve triage factors, 0 to 2 each: ambiguity, reasoning, coupling, risk, verifiability, precedent, context, reversibility, outside dependencies, domain, concurrency, backward compatibility; 3 to 6 is T1, 7 to 10 T2, 11 to 14 T3, 15 to 19 T4, 20 to 24 T5; risk 2 in the changed logic means at least T2), make the first Assumptions line `Raise tier: T<n>: <short reason>`. Never lower the tier.
- Keep summary.md's scope: nothing it does not ask for, no refactors on the side.

## After writing

The planner, or a coder in a `Plan only` round when no planner is installed, ends with its worker result (Changed files: the plan.md path). The orchestrator reads plan.md once and goes on to the next phase.
