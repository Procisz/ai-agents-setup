# Source

- Upstream: https://github.com/addyosmani/web-quality-skills
- Path: skills/seo (SKILL.md, references/STRUCTURED-DATA.md)
- Commit: afa8da942115f2961fdbfa80807ea0b232ff6c00
- Fetched: 2026-10-28
- License: MIT, Copyright (c) 2026 Addy Osmani. LICENSE is the upstream LICENSE file, unchanged.
- Not vendored: the upstream web-quality-audit skill and every scripts/ folder.

## Local changes

SKILL.md:

- Frontmatter replaced: name, a rewritten description (at most 300 characters) and metadata wf-required [] and wf-default [reviewer]. The upstream license, author and version fields were dropped (LICENSE and this file carry them).
- Pagination canonical fixed to match Google Search documentation: the example that canonicalized a paginated page to the first page and the advice to use rel="prev" / rel="next" were replaced by a self-referencing canonical on every page of the series, a rule never to canonicalize page 2 and later to page 1, a note that Google ignores URL fragments for page numbers, sequential crawlable links, and a note that Google no longer uses rel="prev" / rel="next".
- Sitemap fixed to match Google Search documentation: changefreq and priority removed from the XML example; the best practices now say to keep only loc and an accurate lastmod, that Google ignores changefreq and priority, and that lastmod is the date of the last significant change (main content, structured data or links), not the build time.
- Audit checklist: "Canonical URLs set" now says self-referencing, also on paginated pages.
- Tooling: the Lighthouse CLI fallback (workflow paragraph and tools table) applies only when the project already has Lighthouse installed; added the rule to use only tools the project or session already has, never to install global packages, add dependencies or run tools through npx, and to review by reading the code when nothing can run.
- Chrome DevTools MCP in the tools table marked as optional ("when available").
- Link to references/STRUCTURED-DATA.md now uses the skillDir placeholder (the installed skill folder); link to the Core Web Vitals skill now uses the libraryDir placeholder (core-web-vitals/SKILL.md in the installed library).
- Removed the reference link to the upstream web-quality-audit skill, which is not vendored.
- En dashes in "50-60" and "150-160" replaced by hyphens.

references/STRUCTURED-DATA.md: unchanged.
