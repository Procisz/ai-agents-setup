# Source

- Upstream: https://github.com/addyosmani/web-quality-skills
- Path: skills/core-web-vitals (SKILL.md, references/CLS.md, references/INP.md, references/LCP.md)
- Commit: afa8da942115f2961fdbfa80807ea0b232ff6c00
- Fetched: 2026-10-28
- License: MIT, Copyright (c) 2026 Addy Osmani. LICENSE is the upstream LICENSE file, unchanged.
- Not vendored: the upstream web-quality-audit skill and every scripts/ folder.

## Local changes

SKILL.md:

- Frontmatter replaced: name, a rewritten description (at most 300 characters) and metadata wf-required [] and wf-default [reviewer]. The upstream license, author and version fields were dropped (LICENSE and this file carry them).
- Tooling: added the rule to use only tools the project or session already has, never to install global packages, add dependencies or run tools through npx, and to review by reading the code when nothing can run. The Lighthouse CLI row of the measurement sources table applies only when the project already has it installed. The web-vitals recommendation now says that adding it to a project that lacks it is a dependency change to propose, not to install.
- Chrome DevTools MCP mentions in the measurement steps and the measurement sources table marked as optional ("when available").
- Links to references/LCP.md, references/INP.md and references/CLS.md now use the skillDir placeholder (the installed skill folder). Links into the upstream performance skill now point to the vendored web-performance skill through the libraryDir placeholder (web-performance/SKILL.md, web-performance/references/MEASUREMENT.md, web-performance/references/RUM.md); "Performance skill" renamed "Web performance skill".
- Em and en dashes replaced: threshold ranges use hyphens ("2.5s - 4s", "200ms - 500ms", "0.1 - 0.25"), the others a colon.

references/CLS.md, references/INP.md, references/LCP.md: unchanged.
