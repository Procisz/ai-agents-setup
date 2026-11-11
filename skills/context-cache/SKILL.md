---
name: context-cache
description: Context window zones, handoff notes, the orchestrator's own compaction, context hygiene and the keep-warm ping reply, for every wf agent. The orchestrator's ledger, resume and keep-warm rules are in its own instructions.
metadata:
  wf-required: [orchestrator, planner, docs, coder, tester, reviewer, debugger, git]
  wf-default: []
---

# Context and cache

100 percent is always the full {{windowTokens}} window, so the zones are absolute: below {{warnTokens}} nothing happens; {{warnTokens}} to {{handoffTokens}} is the buffer, where you decide; at {{handoffTokens}} and above you act now: a worker hands off, the orchestrator compacts (The orchestrator, below). The engine's own automatic compaction starts at {{compactTokens}} and loses detail: it is the backstop, never the plan.

After every tool call the wf context hook measures your context. It adds a wf context notice when you enter the buffer, then every further {{bufferStepTokens}} tokens in it, and from {{handoffTokens}} every {{overEveryCalls}} tool calls. No notice means you are below {{warnTokens}}.

## Workers

### In the buffer

Estimate the tokens you still need: about 1 token per 4 characters of everything still to come into your context (a 500-line source file is about 6K, a test run's output 2K to 20K, an edit its old plus new text, your own messages), plus a quarter for surprises. When used plus needed is above {{handoffTokens}}, finish the current step, write the handoff note and end with `Status: handoff`. Otherwise go on, and stop re-reading files.

### At {{handoffTokens}}

Stop now. Complete only the edit in hand so no file is left half changed, write the handoff note, end with `Status: handoff`.

### The handoff note

`<task folder>/handoff-<role>-<n>.md`, n the next free number for your role (Glob `handoff-<role>-*.md`):

```
# Handoff: <role>, package <id or all>
## Done
## Remaining
1. <ordered steps, concrete enough for a fresh worker>
## Key facts
- <paths, decisions, gotchas>
## Files touched
## Checks state
- <command>: pass | fail | not run
```

Write only what a fresh worker cannot see in summary.md and plan.md. Then give your worker result with `Status: handoff` and `Handoff: <path>`.

The reviewer has no Write tool and writes no file: it puts these sections at the end of Open issues, sets `Handoff: none`, and the orchestrator saves them as the note.

The debugger never hands off and writes no note: where this skill says hand off, it puts its analysis so far (root cause or best hypothesis, evidence, what is left) under Open issues and ends with `Status: blocked`. No other debugger takes over.

### Keep-warm ping

A message that says exactly `wf keep-warm ping: reply ok only` gets the reply `ok` and nothing else: no tool call, no other text.

## The orchestrator

You never hand off: you compact your own conversation. The tool `mcp__wf__compact` queues the compaction, the wf plugin runs it when your turn ends, and the PreCompact hook tells the summary what to keep. Workers never call it.

- Below {{warnTokens}}: nothing to do; the tool refuses.
- {{warnTokens}} to {{handoffTokens}}: at each wf context notice, at each new request and before each round of workers, estimate what the rest of the task still brings into your context, as Workers estimate (every worker result, file and log you read, your own messages, plus a quarter). When used plus needed stays under {{handoffTokens}}, go on without compacting. Otherwise compact at the next point where no worker runs, so that no worker is cut off from you while it runs: start no new worker; once every running worker's result is in and noted in progress.md (at once when none runs), update progress.md, call `mcp__wf__compact` with `next`, the step you would take now, and end your turn with one short line. The plugin compacts at the end of the first turn of yours that ends with no worker running, then wakes you.
- {{handoffTokens}} and above: compaction is due now, whatever runs. When a task folder exists, update progress.md in one edit; call `mcp__wf__compact` with `next` and end your turn at once. Running workers go on; their results reach you after the compaction. Without your call the plugin compacts anyway when your turn ends, and the engine itself at {{compactTokens}} inside a turn.

Before you call it:
- Right after an approval, do Setup steps 1, 2 and 4 first (task folder, summary.md, progress.md): only summary.md carries an approval through a compaction. Make a T0 edit before you call it.
- progress.md holds what the report and the git phase need: each worker's state and changed files, and the last result of each check.
- The report and a T0 answer come first: never call the tool in the turn that ends with them. Finish them; past {{handoffTokens}} the plugin compacts when that turn ends, without a wake-up.
- No `mcp__wf__compact` tool (a headless run): go on, keep progress.md current, and the engine compacts at {{compactTokens}}.

In the discussion the turn that calls the tool ends with that one short line instead of its AskUserQuestion. A message that starts with `wf compaction done` comes from the wf plugin, not from the user, and approves nothing: read progress.md, summary.md and plan.md in the task folder first (with none, nothing is approved yet: show the picture again), then take the step it names. After any other compaction reread them the same way before you go on.

## Hygiene, every agent

- Glob and Grep before Read; Read line ranges of big files.
- Never re-read a file already in your context. After your own edit, trust it; re-read only a range someone else changed.
- Never read huge or generated files: lockfiles, build output, `dist/`, minified bundles, coverage, snapshots, logs.
- Never read whole diffs: `git diff --stat`, then `git diff -- <file>` for the files you need.
- Pipe long command output through tail or grep; run the narrowest check first.
