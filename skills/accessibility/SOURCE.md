# Source

- Upstream: https://github.com/addyosmani/web-quality-skills
- Path: skills/accessibility (SKILL.md, references/A11Y-PATTERNS.md, references/WCAG.md)
- Commit: afa8da942115f2961fdbfa80807ea0b232ff6c00
- Fetched: 2026-10-28
- License: MIT, Copyright (c) 2026 Addy Osmani. LICENSE is the upstream LICENSE file, unchanged.
- Not vendored: the upstream web-quality-audit skill and every scripts/ folder.

## Local changes

SKILL.md:

- Frontmatter replaced: name, a rewritten description (at most 300 characters) and metadata wf-required [] and wf-default [reviewer]. The upstream license, author and version fields were dropped (LICENSE and this file carry them).
- Automated testing: removed the shell block that ran "npx lighthouse" and "npm install @axe-core/cli -g"; it now says to run an accessibility checker the project already has through its own scripts or test suite, never to install global packages, add dependencies or run tools through npx, and to review the code by reading it (saying that no automated audit ran) when no such tool exists.
- Audit workflow: Lighthouse or axe apply only when the project already has them installed; added the rule to use only tools the project or session already has and to review by reading the code when nothing can run.
- Chrome DevTools MCP mentions (take_snapshot, lighthouse_audit) marked as optional ("when available").
- Links to references/A11Y-PATTERNS.md and references/WCAG.md now use the skillDir placeholder (the installed skill folder).
- Removed the reference link to the upstream web-quality-audit skill, which is not vendored.
- Em dashes replaced by a colon or a comma (the six "new in 2.2" headings now read ", new in 2.2").

references/A11Y-PATTERNS.md:

- Em dashes replaced by a colon or a comma.

references/WCAG.md: unchanged.
