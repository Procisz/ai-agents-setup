---
name: docs-writing
description: Updating a project's docs for an approved change. Docs first, only the files plan.md lists, the doc's own language, tone and structure, runnable examples with one command per block, no assumed clone path, the changelog when plan.md lists it, no em or en dashes.
metadata:
  wf-required: [docs]
  wf-default: []
---

# Docs writing

## Docs first

- Docs are written before the code: describe the behavior summary.md approves and plan.md details, as it will be once the change lands. Never document behavior the summary does not approve.
- When plan.md leaves a user-visible detail open (a flag name, a default), do not choose it: nothing passes your choice to the coder. Write around it and name it under Open issues.

## Find what the change affects

- Search README, docs/, guides, examples, help pages, config references and the changelog for every name the change touches: commands, flags, options, env vars, file paths, outputs, error messages. The search only finds the affected passages.
- Edit those passages only in the files plan.md lists under Docs; name every other hit under Open issues. No rewrites, reordering or reformatting of unrelated text; no new file unless plan.md asks for one.
- Keep references true: renamed headings and their anchors, moved files, relative links (check each target exists).

## Match the doc

- Keep its language: a Hungarian doc stays Hungarian, an English doc stays English.
- Keep its tone (formal or casual, "you" or impersonal), heading levels, list and table style, terminology and spelling.
- Short sentences, plain words, the reader's task first.

## Examples

- Every example runs as written: real command names and flags (check plan.md or the source), complete input, and the expected result when it helps the reader confirm success.
- One command per code block, so a copy button copies exactly one command. Mark the fence language (`sh`, `js`, `json`). No `$ ` prompt prefix unless the doc already uses one everywhere.
- Placeholders in angle brackets (`<task-dir>`), each explained once nearby.
- Never assume where a repository is cloned: no absolute paths such as `/Users/name/projects/app` or `~/code/app`. Say "in the folder where you cloned the repository", give a visible check in its own block (for example `ls package.json` or `git rev-parse --show-toplevel`), then use paths relative to that folder.
- No real secrets or personal data; use obvious example values.

## Changelog

- When plan.md lists the changelog (CHANGELOG.md, HISTORY.md, release notes) under Docs, add the user-visible change under its Unreleased section in the existing format (Keep a Changelog: Added, Changed, Fixed, Removed). One line per change, in the user's words. A changelog plan.md does not list: name it under Open issues.
- Never create a changelog the project does not keep.

## Before finishing

- Search each edited file for U+2012 to U+2015 (figure dash, en dash, em dash, horizontal bar) and replace every hit with a comma, colon or hyphen.
- List every changed file under Changed files and every open choice you made under Assumptions.
