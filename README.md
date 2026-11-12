# ai-agents-setup: wf v2

wf is a personal Claude Code workflow. Type `wf` in a project, describe the change, and approve one short summary. An orchestrator then hands the work to cheaper agents (planner, docs, coder, tester, reviewer, debugger) and reports back briefly.

Every task is sized by difficulty and risk into a tier from T0 to T5, so only the agents that tier needs run.

wf never commits, pushes or opens a pull request unless the approved summary asks for it; then only its git agent does exactly that work.

Requirements: Node 22 or newer (`node --version`), and git plus the GitHub CLI `gh` for the git phase.

Install:

1. Clone the repository. Run this in the folder where you keep your projects:

```
gh repo clone Procisz/ai-agents-setup
```

2. Change into the clone folder.

3. Install wf:

```
node wf.mjs install
```

4. Check the setup:

```
node wf.mjs doctor
```

If doctor warns that a role is new, for example `debugger is new: node wf.mjs install adds it`, run `node wf.mjs install` again.

A visual version of this guide, with a Copy button on every command, is `docs/guide/wf-guide.html`: open it in a browser from your clone folder.

The full install guide (requirements per system, every command and flag, troubleshooting) is in git history. Read it with the command below:

```
git show 75ce713:README.md
```

`node wf.mjs --help` lists every command.
