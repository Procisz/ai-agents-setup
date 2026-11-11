# wf v2 plan (M8)

Approved by the owner on 2026-10-28 (decision D105). This file replaces the v1 plan; v1 lives in git history (last v1 commit 5d1d6f3 on main) and in docs/decisions.md D1 to D104.

Discovery evidence: /Users/procisz/Documents/development/archive/ai-agents-setup-v2-discovery/ (readers.md, research.md, workflow-result.json).

## 1. Goal

A simple, fast, autonomous personal workflow on Claude Code 2.1.312 or newer:

- one discussion with choosable options on every turn, one short plain summary, one explicit approval (nothing changes before it, D117), then no questions until the report;
- tiers T0 to T5 that pick cheaper models for simpler work;
- custom skills per agent, chosen at install, loaded only in wf sessions;
- context window management at 50 and 80 percent: workers hand off, the orchestrator compacts itself at a quiet point (D123), and the engine's lossy 850K compaction is only the backstop;
- a prompt cache per agent (1 hour for coder and debugger, 5 minutes for the others), each kept warm (D139);
- nothing wf in normal `claude` sessions: no wf agents, skills, hooks or settings there.

Evidence that drove it (7 real v1 tasks, $258 list price): cache writes 42 percent of spend because subagents used the 5 minute TTL; the T3 deep trio 67 percent; the full suite ran 6 to 9 times per T3 task inside hooks because coders could not run tests; 58 answers asked; wall time 1.7 to 16 hours for 2 to 119 minutes of agent work.

## 2. The flow

Every request goes to the orchestrator (main thread, `wf`). It triages silently first (skill `triage`). Triage scores difficulty and risk, never file count (D113): twelve factors, 0 to 2 each (D128): ambiguity, reasoning, coupling, risk, verifiability, precedent, context, reversibility, outside dependencies, domain, concurrency and backward compatibility; 0 to 2 and an answer or one obvious edit is T0, 0 to 2 otherwise and 3 to 6 is T1, 7 to 10 is T2, 11 to 14 is T3, 15 to 19 is T4, 20 to 24 is T5 (D133), with risk and extra care (T5) overrides.

| Phase | Runs when | Who |
|---|---|---|
| 1 Discussion | always except T0 questions; until the explicit approval, asking back with options, changing nothing (D117) | orchestrator (skill `discussion`) |
| 2 Summary and approval | always except T0 questions | orchestrator; the only approval |
| 3 Execution plan | after approval | planner at every tier (D112; skill `execution-plan`) |
| 4 Docs | the project has docs the change affects, or the user asked | docs agent |
| 5 Implementation | always | coder agents |
| 6 Tests | the project has tests, or the user asked; always after the code | tester agent |
| 7 Verification | the project has its own check commands (lint, typecheck, build): one run of them; the reviewer agent only when the user asked | the last worker round (tester, else a coder in a checks-only round, D112); reviewer agent |
| 8 Git | only when the approved summary asks for git work (any git work its Git line names: a commit, a push and pull request, a merge, or another git action) | `wf:git` (D115, D127); not installed: left uncommitted, the report lists the commands |
| 9 Report and cleanup | always | orchestrator (skill `final-report`), then `wf-clean` |

With subagents the orchestrator only delegates (D112): planning, coding, tests, checks and reviews are worker rounds; the orchestrator keeps the discussion, triage, the approval, bookkeeping, delegation, monitoring, the report and cleanup; git work goes to `wf:git` (D115).

Rules:

- T0: questions are answered directly with no approval. A tiny edit (one file, obvious) gets the same single approval question with a one-line summary inside it, then the orchestrator does it itself. No agents, no task folder. The one-line summary also names the time (usually about 1 minute, D136), and the reply after the edit starts with a check mark icon (D135).
- Before the approval nothing changes (D117): the orchestrator only reads and talks, writes no file or setting anywhere (project, user settings, other folders), starts no agent and no task folder. Every discussion turn ends with one AskUserQuestion (a question round with 2 or 3 options each plus `Something else`, or the approval question, D130); it asks back while anything is open, with no round limit. The approval is only Approve on the approval question right after the full summary, a typed answer that does nothing but approve it, or an advance approval written in the request ("approved, no questions"); "ok" or "do it" before the approval question, answers to discussion questions and approvals mixed with a question, doubt or change are discussion input. A compaction never gives an approval (D120). The summary names every change, also outside the project, and lists dropped points under Left out; what it does not list is not approved. A T0 answer that suggests changes ends with a multiSelect question (`Which of these should I prepare as a task?`, at most 2 suggestions, `None for now`, `Something else`); a pick or a "do it" starts a discussion, never the work.
- Every discussion turn shows where things stand (D119): while points are open, a Where we are block (Decided, Open, Now I need, each line with an icon, D135) before the question round, and a point never drops out of it; once nothing is open, the full summary (icons on its headings, a Tier line and an Estimate line, D135 and D136) ending with a Now I need line and the approval question (Approve, Change something, Cancel, Something else), on every turn until Approve or Cancel, also after answering a side question. Cancel drops the request with nothing changed. The picture and the summary go inside the first question's text (D120: text beside a tool call can go missing, D37; at most 1,900 characters per question, D53).
- After the approval (D120) a message that drops, narrows or stops approved work is followed; anything the approved summary does not list waits for the report and becomes a new request with its own discussion, summary and approval.
- No questions after the approval. Agents decide open choices and list them as assumptions; the report lists them. Allowed later questions: resume of an interrupted task found at session start (Resume, Discard, Leave it, Something else), and a hard contradiction that makes the approved summary impossible to follow.
- One status line at every phase change: `wf: <phase>: <short status>`.
- Session names (D125, D126): the `hooks/title.mjs` command hook (UserPromptSubmit, plus PostToolUse on Write, and SessionStart with matcher `clear`) names each session `<short AI name>` from the first prompt, with no prefix because the tier is not known yet (Haiku, 12 s, then a fallback from the prompt's first words), in sentence case with spaces, and renames it once to `wf(T<n>)-<task slug>` (the slug's words with spaces, sentence case; `<n>` from the Tier line of the summary, D137, which replaces the `[WF] ` prefix of D126) at the next typed message after the session's first approval, detected from the Write of `.work/<YYYYMMDD-HHMM-slug>/summary.md`. Later approvals never rename; a title the user set is never overwritten. On `/clear` the hook drops the ledger's `title` and prints an empty terminal title; Claude Code drops its own title on `/clear` and ignores an empty `sessionTitle`, so the next typed prompt names the new session. State lives in the session ledger under `title`.
- Workers run in the background (Claude Code's default); the orchestrator waits for their notifications and stays responsive to the user meanwhile.
- Parallel coders: at most 5 at once (D111; 3 in D105), only for plan packages marked independent with disjoint files.
- Fix rounds: test failures or reviewer blocker/major findings go back to a coder, at most 2 rounds per phase; then the report lists what is still open. When the same failure (same signature) comes back after a coder round, the debugger takes it instead (D110): at most once per signature and twice per task. Workers report failures with the test or check name and a log path; the debugger runs alone (running file-editing workers finish first, none start meanwhile); a failure reported after the debugger or the extra coder round is final for the task.
- The coder runs the project's relevant fast checks itself (lint, typecheck, related tests) and updates existing tests that its intended change breaks. New tests are the tester's job when the tests phase is on.
- Git only when approved, always through `wf:git` (D115): the orchestrator records `git status --porcelain` at the start in progress.md and hands `wf:git` the list of files the task changed; `wf:git` does exactly the git work the approved Git line names (any git or gh command, D127); without a named branch it works on a feature branch and opens a pull request (its `git` skill). Branch setup before the work happens only when the summary asks or names a pull request base.

### Task folder (temporary)

- `<project>/.work/.gitignore` containing `*` (created when missing).
- `<project>/.work/<YYYYMMDD-HHMM-slug>/`:
  - `summary.md`: the approved summary, verbatim.
  - `plan.md`: the execution plan.
  - `progress.md`: written only by the orchestrator: phase table, worker ids, roles, status, baseline `git status`, the background task id of the wf-keepwarm watcher, assumptions and open issues as they come in.
  - `handoff-<role>-<n>.md`: worker handoff notes.
  - `notes/`: worker scratch files.
- At the end `wf-clean <absolute task dir>` deletes the task folder, and `.work/` too when only `.gitignore` is left.

### Worker result (plain text, the worker's last message)

```
Status: done | handoff | blocked
Summary: 2 to 5 lines
Changed files: paths, or none
Checks: <command>: pass or fail, one line each
Assumptions: decisions made without asking, or none
Open issues: or none
Handoff: <path>, only with Status handoff
```

No hook validates it; it is a format in the shared worker block.

## 3. Roles, models and effort

Default effort of all 5.5 models is medium. Every model has a 1M context window by default (no setting needed).

| Role | T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|
| orchestrator (main thread, D129) | Sonnet 5.5 medium, one agent for every tier | | | | |
| planner | Haiku 5.5 medium | Sonnet 5.5 low | Sonnet 5.5 medium | Sonnet 5.5 high | Opus 5.5 high |
| docs | Haiku 5.5 low | Haiku 5.5 medium | Haiku 5.5 high | Sonnet 5.5 low | Sonnet 5.5 medium |
| coder | Haiku 5.5 low | Haiku 5.5 medium | Haiku 5.5 high | Sonnet 5.5 medium | Sonnet 5.5 high |
| tester | Haiku 5.5 low | Haiku 5.5 medium | Haiku 5.5 high | Sonnet 5.5 medium | Sonnet 5.5 high |
| reviewer (on request) | Haiku 5.5 medium | Sonnet 5.5 low | Sonnet 5.5 medium | Sonnet 5.5 high | Opus 5.5 high |
| debugger (repeated failure, D110) | Sonnet 5.5 low | Sonnet 5.5 medium | Sonnet 5.5 high | Opus 5.5 medium | Opus 5.5 high |
| git (one agent, D115, D131, D140) | Haiku 5.5 medium, one agent for every tier | | | | |

The model and effort spread is D134, which replaces the tables of D129 and D132. High effort is used for the coder, tester and debugger at T3 and T5, the docs agent at T3, the planner and the reviewer at T4 and T5 (D140 moved the planner at T1 and the git agent to medium).

Model ids: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.

Agent files (plugin `wf`, so Claude Code names them `wf:<name>`): `orchestrator`, `planner-t1` to `planner-t5` (D112), `docs-t1` to `docs-t5`, `coder-t1` to `coder-t5`, `tester-t1` to `tester-t5`, `reviewer-t1` to `reviewer-t5`, `debugger-t1` to `debugger-t5` (D110) and `git` (one agent for every tier, D115): 32 with everything installed. One body per role; the tier variants differ only in model and effort.

Tools: orchestrator has no tools line (every tool, D103 kept). planner: Read, Glob, Grep, Write, Edit, Bash. docs: Read, Glob, Grep, Write, Edit. coder and tester: Read, Glob, Grep, Write, Edit, Bash. reviewer: Read, Glob, Grep, Bash. debugger: Read, Glob, Grep, Write, Edit, Bash. git: no tools line (every tool, MCP servers included, D115). No `maxTurns` anywhere (context management replaces it). No worker has Agent or Skill.

`wf-settings.json` (passed with `--settings`, wf sessions only) denies `Agent(model:*)` and `Agent(effort:*)` so the pinned models hold, and the tools wf never uses (`Artifact`, `Workflow`, `ScheduleWakeup`, `SendFeedback`, `ReportFindings`, `ListAgents`, D118) so wf sessions do not load them; lint requires both lists. It also sets `"ultracode": false` (D122), so a wf session never runs standing Workflow orchestration, whatever the user settings say; lint requires it.

## 4. Skills

### Format

`skills/<name>/SKILL.md`, optional `references/`, and for vendored skills `LICENSE` and `SOURCE.md` (upstream URL, pinned commit, date, every local change). Frontmatter (a small YAML subset: scalars, flow lists, one nested map):

```
---
name: testing
description: One line, at most 300 characters.
metadata:
  wf-required: [tester]
  wf-default: []
---
```

Roles: `orchestrator`, `planner`, `docs`, `coder`, `tester`, `reviewer`, `debugger`. `wf-required` roles always get the skill (locked in the installer); `wf-default` roles get it preselected. Adding a skill needs no other file change. `{{skillDir}}` in a skill body becomes the installed absolute folder path (for references).

### Delivery

- Skills are copied to `<appDir>/plugin/library/<name>/`, not to the plugin's `skills/` folder, so they are never registered as Claude Code skills (no listing, no auto-invocation, no clash with synced claude.ai skills).
- The skills selected for a role are inlined into that role's agent body at install (all its tier variants): `<wf-skill name="x" path="<abs SKILL.md>">` body `</wf-skill>`. The body is the system prompt, so the skill is always loaded and survives compaction. This also covers the orchestrator, whose frontmatter `skills:` the main thread would ignore.
- Every agent body ends with a "Skill library" index of the installed skills it did not get inline: name, description, absolute SKILL.md path. The planner names the library skills each package needs in plan.md; workers Read them on demand.

### The skills (15)

| Skill | Source | Required | Default |
|---|---|---|---|
| discussion | ours | orchestrator | |
| triage | ours | orchestrator | |
| execution-plan | ours | orchestrator, planner | |
| final-report | ours | orchestrator | |
| context-cache | ours | all seven roles | |
| javascript | ours | | planner, coder, tester, reviewer, debugger |
| testing | ours | tester | coder, debugger |
| vitest | ours, with the antfu/skills vitest references vendored under references/ | | tester |
| docs-writing | ours | docs | |
| code-review | ours | reviewer | |
| debugging | ours (D110) | debugger | |
| seo | vendored: addyosmani/web-quality-skills skills/seo, patched (Google no longer uses rel=prev/next, never canonicalize paginated pages to page 1, Google ignores changefreq and priority) | | reviewer |
| core-web-vitals | vendored: addyosmani/web-quality-skills skills/core-web-vitals | | reviewer |
| web-performance | vendored: addyosmani/web-quality-skills skills/performance | | reviewer |
| accessibility | vendored: addyosmani/web-quality-skills skills/accessibility (WCAG 2.2) | | reviewer |

Pinned sources: addyosmani/web-quality-skills at afa8da942115f2961fdbfa80807ea0b232ff6c00 (MIT, Addy Osmani); antfu/skills at 8886fe2d385d3644cbb47e46ae9cb1cf09307d3b, path skills/vitest (MIT, Anthony Fu). Vendored text is normalized to the house rules (every em and en dash replaced by a comma, colon or hyphen) and must not tell agents to install global packages or fetch remote code; each change is listed in SOURCE.md. No scripts are vendored.

### Installer steps (D109)

`node wf.mjs install` in a terminal shows a header and five guided steps, each with "Step n of 5", a 2 to 4 line explanation of the decision and a one-line result after the answer:

1. Tiers T1 to T5 (at least one). A task that fits a missing tier runs as the nearest installed tier, the higher one on a tie.
2. Agents planner, docs, coder, tester, reviewer, only those the chosen tiers use; coder locked. Fallbacks: no planner, the orchestrator writes plan.md; no docs, the coder does the docs steps; no tester, the coder writes and runs the tests after its code; no reviewer, the orchestrator reviews the diff itself when asked.
3. Models Opus, Sonnet, Haiku 5.5 (at least one). An agent whose model is unticked runs on the nearest ticked one, the stronger on a tie.
4. Skills: one checklist per installed role: required ticked and locked, default ticked, others unticked.
5. Summary (role by tier with agent, model and effort, remaps, missing tiers and roles with their fallback, skills per role), then Install, Change choices or Cancel.

Every step starts from the answer saved in the manifest, else everything ticked (the skills from their defaults, plus the defaults of skills added since). `--yes`, `--json` or no terminal: no questions, saved answers or defaults. `--reset` (alias `--skills-reset`): defaults. Compile writes only the chosen variants, remaps models, lists only installed agents in `{{agentTable}}` and renders `{{setupNotes}}` with one line per missing tier, role or remapped model. Colors and icons appear only in a terminal (NO_COLOR and FORCE_COLOR honoured, ASCII fallback on a dumb terminal or an old Windows console).

## 5. Context window management

Zones (registry `context`): below 50 percent nothing happens; 50 to 80 percent is the buffer, where the agent decides; 80 percent and above means act now: a worker hands off, the orchestrator compacts itself (D123). 100 percent always means the full 1,000,000-token window of the 5.5 models, so the zones are absolute: 500K and 800K tokens.

- wf never sets `autoCompactWindow` (settings, modelSettings or agent frontmatter) or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: those redefine the window itself, so 100 percent would become the smaller number (the owner's experience). Lint refuses them in registry, personas and wf-settings.json.
- The only compaction setting is `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, which in 2.1.312 moves the trigger only (`testPctOverride` feeds the threshold; `effectiveWindow` is unchanged). Its value is a percent of the window minus the 20K output reserve (980,000), so 86.74 puts the trigger at 850,052 tokens.

- Measurement: plugin hook `hooks/context.mjs` on PostToolUse (every tool, wf sessions only). It reads the agent's own transcript tail: a subagent's is `<dirname(transcript_path)>/<session_id>/subagents/**/agent-<agent_id>.jsonl`, the main thread's is `transcript_path`. Context = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of the last assistant line with `message.usage`. It records every agent in a ledger `<appDir>/state/<session_id>.json` (atomic write; files older than 7 days pruned when a new one is created).
- Nudges (hookSpecificOutput.additionalContext, seen by that agent on its next request): on entering the buffer, then every further 50K tokens in it; on reaching 80 percent, then every 5 tool calls.
  - Worker in the buffer: estimate the tokens still needed; if used plus needed exceeds 800K, finish the current step, write the handoff note and end with Status handoff; otherwise continue and avoid re-reading files.
  - Worker at 80 percent: stop now, write the handoff note, end with Status handoff.
  - Orchestrator in the buffer: estimate what the rest of the task still brings in; under 800K in total go on without compacting; otherwise compact at the next point where no worker runs (start no new worker, then update progress.md, call `mcp__wf__compact` with `next`, end the turn).
  - Orchestrator at 80 percent: compaction is due now, whatever runs: update progress.md in one edit (with a task folder), call `mcp__wf__compact` with `next`, end the turn at once, in the discussion too.
- The orchestrator acts on a handoff by starting a fresh worker of the same role with summary.md, plan.md and the handoff note. Before resuming any finished worker (fix rounds) it reads the ledger (`wf-agents`): resume only when the worker's context plus the expected work stays under 800K, else start fresh with a handoff note it writes itself.
- Orchestrator compaction (D123): the plugin's hooks module `hooks/compact.mjs` (named under `modules` in hooks.json, run by Claude Code's plugin hooks API, no Node) registers the tool `mcp__wf__compact` (input `next`, the step to take after the compaction; non-deferred; allowed in wf-settings.json). A plugin can make Claude Code compact only between turns, so the module acts on the main loop's `turn.complete`: it reads the context with `$.session.usage()` and the running subagents (`pending`, `running`, `waiting`) with `$.agent.list()`, then decides. A queued request in the buffer waits until a turn ends with no subagent running; from 800K it compacts at the turn end whatever runs, also without a request. It calls `$.session.compact({ instructions })` with the `next` step when one was requested, then, when a request exists, no subagent runs and the turn ended normally, wakes the orchestrator with `$.prompt.submit`: a message that starts with `wf compaction done`, says it comes from the plugin and approves nothing, and repeats `next`. The tool refuses a worker and any call below 500K. A wake-up turn never wakes again, a stale usage reading right after a compaction does not compact twice, and an engine or manual compaction, a `/clear` or resume (`session.end`), a turn end below 500K and a turn that ends with `wf: report:` drop the request. The rules: right after an approval Setup steps 1, 2 and 4 come before the call (only summary.md carries an approval through a compaction); never call it in the turn that ends with the report or a T0 answer; progress.md keeps each worker's changed files and a Checks section for the report and the git phase (D124). The limits come from `hooks/config.json` and scale with `WF_CONTEXT_WINDOW` like the context hook. Plugin compaction is not available in a headless `-p` run, so the module registers the tool only when `session.start` says `isInteractive`.
- Backstop: the launcher sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=86.74`, so the engine's automatic compaction starts at 850K of the 1M window for every agent, inside a turn too. A PreCompact hook prints what the summary must keep (task folder path, the approved summary or, before the approval, the last summary marked NOT APPROVED with the open points and the user's answers (D120), phase, worker ids and states, assumptions, open issues).
- Hook errors never block: any failure of a command hook exits 0 and appends one line to `<appDir>/state/hook-errors.log`. The compaction module has no Node and writes no log file: its failures show as a dim transcript line (`$.ui.log`), a missing hooks/config.json in the debug log. `WF_CONTEXT_WINDOW` overrides the window (for live checks).

## 6. Prompt cache

- The main thread already uses the 1 hour TTL on a subscription. Each non-main agent sets its TTL in its frontmatter as `experimental.cacheTtl` (D139): coder and debugger `"1h"`, tester, planner, docs, reviewer and git `"5m"`. The orchestrator keeps the main-thread default. The launcher no longer sets `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`: that global variable beat the per-agent setting, so it is removed (a 1h write costs 2x input against 1.25x for 5m; reads 0.05x on Opus and Sonnet 5.5 and refresh the TTL for free).
- The earlier rule of no 5 minute keep-warm (about 12 pings an hour plus an orchestrator turn each cost about one rewrite) is superseded for the 5 minute agents (D139): they are pinged only for a limited time after their last real work.
- Keep-warm for the 1 hour cache: the main thread, coder and debugger are pinged at 58 minutes (owner, 2026-10-28: 2 minutes of safety before the 60 minute expiry). Keep-warm for the 5 minute cache: the tester, planner, docs, reviewer and git agents are pinged about every 4 minutes (`keepwarmShortMinutes`), but only while their last real work is at most 30 minutes old (`keepwarmShortMaxMinutes`); after that the watcher ignores them, and resuming them later pays a cache rewrite. The TTL counts from the start of an agent's last request, which is the timestamp of the last user-type line (user message, tool result, notification or SendMessage) in its transcript. A keep-warm ping does not count as real work.
  - Watcher: `wf-keepwarm` (plugin bin, `scripts/wf-keepwarm.mjs`), started by the orchestrator with Bash `run_in_background` right after the approval and again after every wake-up. It watches the main thread and every subagent of the session, which it finds by itself from the session ledger (`<appDir>/state/<session_id>.json`, the `agents` keys), finished workers included; running workers keep themselves warm. `--agents <id,...>` is optional and adds ids the ledger does not hold; an explicit id whose transcript cannot be found exits 1 with `cannot find agent <id>`, while a discovered agent without a readable transcript is skipped silently. It takes each agent's TTL from its type (`hooks/config.json`, role map `cacheTtl`; an unknown type keeps the 58 minute rule). It polls every 20 seconds, costs no tokens while waiting, and exits with one line `wf keep-warm: ping <main|agent id> (idle <m> min)` as soon as a watched agent has been idle for its limit: 58 minutes for main and 1 hour agents (`WF_KEEPWARM_MINUTES` overrides that value only, for tests), 4 minutes for 5 minute agents. It also exits quietly when the task folder is gone.
  - Unverified: `experimental.cacheTtl` was read from the Claude Code binary (2.1.312), not from its documentation, and has not run live. The compiled-file test proves that wf writes it into every agent file; a live check (`ephemeral_1h` or 5 minute cache writes in a worker transcript) is still open.
  - The exit wakes the orchestrator through the background task notification, and that turn itself refreshes the orchestrator's cache. For a worker it sends SendMessage `wf keep-warm ping: reply ok only`, which resumes the worker for one short request and refreshes its cache; it sends none to a worker that progress.md shows as running, and the git agent's `ok` reply is ignored, since its result stays final. Then it restarts the watcher.
  - Cap: after 6 main-thread keep-warm pings in a row with no other activity (about 6 hours of nothing; worker pings do not count), the orchestrator stops the watcher and notes it in progress.md; any new activity restarts it. At the report the watcher is stopped (TaskStop) and nothing is left running.

## 7. Safety

- `hooks/guard.mjs` on PreToolUse Bash (handlers with `if` filters `Bash(*git*)` and `Bash(*gh *)`), wf sessions only. It ports the v1 tokenizer (`hooks/shell.mjs` splitCommands, tokenize, gitInvocations, ghInvocations, which see through `bash -c`, `sh -c`, `env`, `sudo`, `timeout`, `xargs`, `command`, operators and subshells) into `hooks/git.mjs`.
  - Read-only git is allowed for everyone: status, diff, log, show, blame, grep, ls-files, ls-tree, rev-parse, rev-list, describe, shortlog, merge-base, cat-file, show-ref, for-each-ref, check-ignore, var, version, help, fetch, branch and tag in list forms only, stash list and show, remote -v and show, config --get and --list, worktree list.
  - `wf:git` (agent type, D115): every git and gh command is allowed, not parsed.
  - Everyone else, the orchestrator included: every other git command and every gh write is refused, as are program-running config and environment values (`-c`, `GIT_*`, exported earlier in the same command too). The `allow-git` file is retired.
  - The limits of `wf:git` come from the approved Git line, not from a branch rule in the `git` skill (D127): it may delete branches, force push, push or commit to main, rebase, reset, tag, amend and merge, but only the work the Git line names.
  - Refusal: exit 2, stderr `wf guard: <who> may not run "<command>": <reason>.` A parse failure refuses only when the text contains git or gh followed by a write-looking word; otherwise it allows.
- House rules stay a global rule file (`prompts/house-rules.md` -> `~/.claude/rules/wf-house-rules.md`), updated to v2 wording: only `wf:git` commits, pushes or runs any other git write, only when the approved summary says so, exactly the git work the summary's Git line names: any git or gh command is allowed for that work (deleting branches, a force push, a push or commit to main, rebase, reset, tags, amend, merge) and nothing the Git line does not name; unless the Git line says otherwise it commits on a feature branch and opens a pull request (the guard keeps every other agent read-only), the M8 grant, and the docs-follow rule (D138): every behavior change updates, in the same task and unasked, all docs and guidelines that describe it (README, docs/, guides, changelogs, skills, agent prompts, rule files), and a change is not done while any of them still describes the old behavior.
- Workers never delete with rm and a glob, a variable or a relative path; scratch goes to `.work/<task>/notes/`.

## 8. Install layout

Install root: `<configHome>/ai-agents-setup/` (configHome is `CLAUDE_CONFIG_DIR` or `~/.claude`), called appDir:

```
appDir/
  manifest.json            wf.manifest/2
  wf-settings.json         permissions.allow mcp__wf__compact (D123); permissions.deny Agent(model:*), Agent(effort:*) and the unused tools (D118); outputStyle Concise (D114); ultracode false (D122)
  plugin/
    .claude-plugin/plugin.json   {"name": "wf", "version": "2.1.1", "description": ..., "author": {"name": "Procisz"}}
    agents/<agent>.md            32 files with everything installed, skills inlined
    library/<skill>/...          16 skills
    hooks/hooks.json             PreToolUse guard, PostToolUse context, PostToolUse Write title, UserPromptSubmit title, PreCompact context; modules ./compact.mjs (D123)
    hooks/*.mjs                  guard.mjs, git.mjs, context.mjs, compact.mjs, title.mjs (D125), config.json (window, zones, stateDir)
    bin/wf-agents, bin/wf-clean, bin/wf-keepwarm   sh wrappers (and .cmd on Windows) calling the absolute node path
    scripts/wf-agents.mjs, scripts/wf-clean.mjs, scripts/wf-keepwarm.mjs
  state/                   context ledgers, hook-errors.log
  backups/<UTC stamp>/     index.json + files, 5 kept
  adopted/                 v1 originals (kept for restore)
<configHome>/rules/wf-house-rules.md
<launcherDir>/wf (+ wf.cmd on Windows)
```

Hook commands use the exec form with the absolute node path (`nodePath`, resolved as in v1 including `local.json`) and absolute script paths. Hook matchers that contain a colon are regexes in Claude Code: anchor any agent-name matcher (`^wf:coder-t1$`); the guard and context hooks match by tool name only.

Launcher (POSIX):

```
#!/bin/sh
export BASH_DEFAULT_TIMEOUT_MS='600000'
export BASH_MAX_TIMEOUT_MS='600000'
export CLAUDE_CODE_THRIFTY_SONIC='0'
export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='1'
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='86.74'
export CLAUDE_CODE_DISABLE_FAST_MODE='1'
exec claude --plugin-dir '<appDir>/plugin' --settings '<appDir>/wf-settings.json' --agent wf:orchestrator "$@"
```

Windows: `wf.cmd` with `set` lines and the same arguments, plus the Git Bash `wf`.

`install` never writes `~/.claude/settings.json`, except the one-time v1 migration.

### Commands

`node wf.mjs install [--yes] [--dry-run] [--reset]` (`--skills-reset` is an alias of `--reset`), `uninstall [--yes]`, `restore [--to <stamp>]`, `diff`, `doctor`, `lint [--self]`. Test-only flags: `--config-dir <dir>`, `--launcher-dir <dir>`, `--skip-claude`.

Install: check Claude Code (`claude --version` at least `claude.minVersion` 2.1.312, else refuse with the `claude update` hint; `--skip-claude` for tests), lint the sources, skills step, compile, plan (v1 migration plus file actions against the v2 manifest: create, update, unchanged, remove), show the plan, confirm (terminal and no `--yes`), backup set, write, manifest, verify (re-hash; `claude plugin validate <plugin dir>` when the command exists, a failure is reported, not rolled back), print a PATH hint when the launcher folder is not on PATH. A second install with no changes reports 0 changes.

Uninstall: back up and remove every manifest file, the plugin folder, wf-settings.json, the launcher and state/; restore the adopted `rules/house-rules.md` original when present; keep backups/ and adopted/. Restore: put back a backup set (latest by default).

Doctor: node and Claude Code versions, launcher present and on PATH, manifest hashes, plugin validate, no v1 leftovers (wf hooks in settings.json, `agents/wf-*.md`, the v1 Explore override), state folder writable, a hook self-test (guard refuses a subagent `git commit`, allows `git status` and a `wf:git` commit; context reads a fixture transcript).

Lint: registry schema; persona frontmatter; skill frontmatter (name equals folder, description present and at most 300 characters, roles valid); compiled agents; `--self` the house rules over the repo (no comments in .mjs and .js except TODO, no U+2012 to U+2015 in .md .mjs .js .json .yml .html .sh, LF, no BOM).

### v1 migration (when `appDir/manifest.json` has schema `wf.manifest/1`)

Back up everything first, then:

- Remove every v1 manifest file: `agents/wf-*.md`, `ai-agents-setup/hooks/*`, the v1 launcher (replaced), `rules/wf-house-rules.md` (replaced by the v2 file). Modified files are backed up and removed too.
- `agents/Explore.md` (v1 override, adopted): restore the user's original from `appDir/adopted/agents/Explore.md` when its sha256 matches the adopted record; else remove the v1 override and report it.
- `rules/house-rules.md` stays adopted (the v2 rule file replaces it).
- `settings.json` (keep the file's indentation, tabs in the live file, and a trailing newline): remove every hook handler whose command or args point into `<appDir>/hooks/`, then empty matcher groups and empty event arrays; remove the deny rules `Agent(model:*)` and `Agent(effort:*)` when the manifest says not preexisting; remove `env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` when the manifest says it was absent before v1; prune `env`, `permissions.deny`, `permissions` and `hooks` only when v1 created them and they are now empty. Keep everything else, including `permissions.defaultMode`, `skipDangerousModePermissionPrompt`, `model`, `modelSettings`, `ultracode`, `disableClaudeAiConnectors`, `enableWorkflows`, the user's own hooks (the PermissionRequest hook) and env.
- Leave `homeTrust` (the home folder trust key in `~/.claude.json`) and `appDir/cost/` as they are; record both in the migration report.
- The v2 manifest records `migratedFromV1` (time, backup stamp, removed, restored, settings removed and kept).

## 9. Repository after M8

Kept or rewritten: `wf.mjs`, `package.json` (scripts test and lint), `registry.json` (v2), `local.example.json`, `personas/` (orchestrator, planner, docs, coder, tester, reviewer, debugger), `prompts/house-rules.md`, `prompts/worker.md` (shared worker block), `skills/` (15), `hooks/guard.mjs`, `hooks/git.mjs`, `hooks/context.mjs`, `scripts/wf-agents.mjs`, `scripts/wf-clean.mjs`, `scripts/wf-keepwarm.mjs`, `lib/` (main, core, compile, skills, select, prompt, apply, migrate, doctor, lint, claude), `test/` (new suite), `README.md`, `docs/PLAN.md`, `docs/decisions.md`, `docs/PROGRESS.md`, `docs/guide/wf-guide.html`, `.github/workflows/ci.yml` (node 22 and 24, test and lint).

Removed (git history keeps them): `lib/probe.mjs`, `lib/trial.mjs`, `lib/cost.mjs`, `lib/prices.mjs`, `lib/settings.mjs`, `lib/trust.mjs`, `lib/update.mjs`, `hooks/common.mjs`, `hooks/shell.mjs` (after the port), `hooks/gate.mjs`, `hooks/stop.mjs`, `hooks/ledger.mjs`, `hooks/session.mjs`, the old personas (scout, coder-hard, debugger, git, plan-writer, spec-writer, test-writer, test-writer-deep, verifier, verifier-deep, explore), `prompts/baseline.md`, `prompts/contract.md`, `prompts/result-schema.json`, every old test, fixture, golden and probe file, `trials/`, `.github/workflows/probe.yml`, `.github/scripts/`, `docs/INTERFACES.md`, `docs/INTERFACES-HISTORY.md`, `docs/M3-PLAN.md` to `docs/M7-PLAN.md`, `docs/M6-TRIAL.md`, `docs/ai-agents-setup-guide.pdf`, `docs/guide/ai-agents-setup-guide.html`.

Code style: zero dependencies, Node 22+, ESM `.mjs`, English, no comments (TODO only), no em or en dashes, LF.

## 10. Tests

`node --test test/`, target a few hundred tests and under 30 seconds, no network, no real `~/.claude`: every install test uses temporary config and launcher folders. Covered: skill parsing and validation; compile (frontmatter, tier variants, inlined skills, library index, hooks.json, plugin.json, launchers for POSIX and Windows, wf-settings.json); the skills step (defaults, required, saved answers, non-terminal); install, idempotent reinstall, uninstall and restore; v1 migration from a fixture shaped like the real v1 install (manifest wf.manifest/1, a tab-indented settings.json with the 26 v1 handlers, the user's PermissionRequest hook, deny rules, env, agents, the adopted Explore original); the guard matrix (commands x worker, orchestrator and `wf:git`, wrappers, exported variables, parse failures); the context hook (fixture transcripts, main and subagent paths, absolute 500K and 800K zones on a 1M window, nudge cadence, ledger, PreCompact text, error tolerance); the keep-warm watcher (fixture transcripts with timestamps and an injected clock: exits at 58 minutes for the right target, ignores running workers, exits when the task folder is gone); wf-clean path validation; lint (including the refusal of autoCompactWindow and CLAUDE_CODE_AUTO_COMPACT_WINDOW). No tests pin persona or skill prose beyond the presence of required sections.

## 11. Docs

`README.md` short: what wf is, install, daily use, the flow, tiers and models, skills (how to add one), context and cache, safety, uninstall, troubleshooting. `docs/guide/wf-guide.html`: a short visual guide in the v1 guide's style (dark copy boxes with a Copy button, one command per box; never assume where the clone lives, D97). No PDF (the owner dropped it again on 2026-10-28, D116). The guide has a sticky sidebar that tracks the section in view, and a sticky current-section bar on narrow screens. `docs/decisions.md`: D105 onward.

## 12. M8 steps

| Step | Content |
|---|---|
| M8.0 | Branch m8, this plan, D105, progress log, memory |
| M8.1 | Build workflow: personas and process skills; engineering skills; vendored skills; hooks and scripts; installer |
| M8.2 | Integrate: remove v1 files, test suite and lint green, sandbox install including the v1 migration from a copy of the real install |
| M8.3 | Adversarial review by dimension, verify, fix |
| M8.4 | README, guide, decisions |
| M8.5 | Install on this Mac (backup), doctor, live checks (cap $5) |
| M8.6 | Boundary: commit, push m8, fast-forward main, push main |

Grant (owner, 2026-10-28): inside M8 commit and push only to the branch `m8`; never force; at the boundary fast-forward main and push it.

## 13. Live checks (M8.5, cap $5 in total)

In a throwaway git project in the session scratchpad, through the installed `wf` launcher with `-p`:

- L1: the orchestrator runs as `wf:orchestrator` and lists the wf agents it can delegate to.
- L2: with `WF_CONTEXT_WINDOW=60000`, a `wf:coder-t1` worker that reads a few files reports the wf context notice it received.
- L3: that worker's transcript shows 1 hour cache writes (`ephemeral_1h_input_tokens` above 0, 5 minute writes 0).
- L4: a worker's `git commit --allow-empty -m test` is refused by the guard and HEAD does not move.
- L5: a T1 task end to end with the approval given in advance in the request: the change is made, the report is printed, `.work/` is gone, nothing is committed.
- L6: the window stays 1M under the launcher env: a wf session reports a 1,000,000-token window (`/context` or the transcript's compaction log line `effectiveWindow`), not 850K.
- L7: `wf-keepwarm` with `WF_KEEPWARM_MINUTES=1` against the transcripts of L2 exits with the right ping line after about one minute of idleness.
- L8 (D123): in an interactive sandbox session with a plain terminal environment and a scaled `WF_CONTEXT_WINDOW`, the compact module loads and registers `mcp__wf__compact`. Past the scaled 80 percent the orchestrator calls it after a context notice, ends its turn, is compacted at the turn end and woken by `wf compaction done`. Without a call the module compacts at the turn end anyway, without a wake-up. In the buffer with a short task the orchestrator does not compact.
