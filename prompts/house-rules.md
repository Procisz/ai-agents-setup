# House rules

These apply in every project, to every agent, in code, tests, docs and chat.

## Code language: English
- Write all code in English: identifiers, test descriptions (describe/it), log and console output, script text.
- Hungarian appears only in data, above all i18n dictionaries and the user-facing strings they hold. Tests may compare against Hungarian UI text, because that text is data.

## No comments in code
- Do not add comments to source code or tests. The only allowed marker is a TODO.
- Put the reason in a test name, an assertion message or the docs instead.
- Before finishing, check the diff for added comment lines.

## Never commit or push unasked
- Never run git commit or git push unless the user explicitly asks for it in the current message.
- Leave finished work uncommitted in the working tree: the user reviews the diff in the VS Code Source Control panel. Offer the commit command instead of running it.
- wf agents (the orchestrator and every wf worker) never commit, push or run any other git write unless the summary the user approved at the start says so; then only `wf:git` does it, exactly the git work the summary's Git line names: any git or gh command is allowed for that work (deleting branches, a force push, a push or commit to main, rebase, reset, tags, amend, merge), and nothing the Git line does not name. Unless the Git line says otherwise it stages only the task's own files, commits on a feature branch and opens a pull request. A guard hook refuses git and gh writes from every other wf agent; it cannot see writes inside script files or package scripts, so never route one through them.
- Exception (owner, 2026-10-08): in `amelia-dashboard-project`, while executing its `EXECUTION_PLAN.md`, commit each finished plan step without asking (through the pre-commit hook, never pushing); that repo's `.claude/claude.md` and plan §0.4 and §6 hold the rule.
- Exception (owner, 2026-10-08): in `ai-agents-setup`, commit all changes and push to origin at every milestone boundary without asking; inside a milestone, push only to a branch the owner granted for that milestone (M8: `m8`), never to main and never with force (docs/PLAN.md section 12, decisions D58, D59, D72, D83, D87 and D105).

## Docs follow every behavior change
- Every behavior change updates, in the same task and unasked, all docs and guidelines that describe it: README, docs/, guides, changelogs, skills, agent prompts and rule files.
- A change is not done while any of them still describes the old behavior.

## No em or en dashes
- Never use an em dash or an en dash anywhere: code, docs, commit messages, chat. Use a comma, a colon or a hyphen instead.
- Before reporting a task done, check new or edited text for those two characters.
