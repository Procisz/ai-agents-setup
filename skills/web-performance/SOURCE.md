# Source

- Upstream: https://github.com/addyosmani/web-quality-skills
- Path: skills/performance (SKILL.md, references/MEASUREMENT.md, references/RUM.md), vendored as skills/web-performance
- Commit: afa8da942115f2961fdbfa80807ea0b232ff6c00
- Fetched: 2026-10-28
- License: MIT, Copyright (c) 2026 Addy Osmani. LICENSE is the upstream LICENSE file, unchanged.
- Not vendored: the upstream web-quality-audit skill and every scripts/ folder.

## Local changes

SKILL.md:

- Renamed from performance to web-performance (folder and frontmatter name).
- Frontmatter replaced: name, a rewritten description (at most 300 characters) and metadata wf-required [] and wf-default [reviewer]. The upstream license, author and version fields were dropped (LICENSE and this file carry them).
- Tooling: added the rule to use only tools the project or session already has, never to install global packages, add dependencies or run tools through npx, and to review by reading the code when nothing can run. The web-vitals recommendation now says to propose adding it to a project that lacks it instead of installing it.
- Chrome DevTools MCP trace tools marked as optional ("when available").
- Links to references/MEASUREMENT.md and references/RUM.md now use the skillDir placeholder (the installed skill folder); links to the Core Web Vitals skill now use the libraryDir placeholder (core-web-vitals/SKILL.md in the installed library), and the anchor link became "the LCP section of core-web-vitals".
- Em and en dashes replaced by a hyphen ("20-30%"), a colon or a comma.

references/MEASUREMENT.md:

- Chrome DevTools MCP route marked as optional ("when available").
- Fallbacks: added the rule never to install global packages, add dependencies or run tools through npx to get a measurement; the Lighthouse CLI fallback applies only when the project already has Lighthouse installed and runs it through the project's own scripts or binaries (the upstream text allowed a temporary install).

references/RUM.md:

- The web-vitals recommendation now says that adding it to a project that lacks it is a dependency change to propose and get authorized, not to install.
