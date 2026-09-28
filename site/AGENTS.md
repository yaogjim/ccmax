# React Site Instructions

These rules apply to the public landing page and documentation experience under `site/`.

## Contracts that must not break

- Keep the site independently installable with `npm ci` and buildable with `npm run build`.
- Keep `npm run check` deterministic, offline, and responsible for site-specific validation beyond compilation.
- Publish to the GitHub Pages project site `https://yaogjim.github.io/ccmax/`. Vite `base` is `/ccmax/`. Public asset and canonical URLs must include that base; physical output stays at `site/dist/<route>/index.html` because Pages maps the uploaded artifact root onto `/ccmax/`. Do not nest `dist/ccmax/` and do not ship a CNAME.
- `src/lib/site.js` is the only source of origin, base, and public URL composition for Vite config, Node scripts, and browser code.
- Treat files under `docs/` as the source of truth for long-form Chinese and English documentation. Keep paired public routes aligned when both languages exist.
- `docs/agents/` is internal project material, not documentation. Keep it out of the generated manifest and the published artifact.
- Do not copy private user state, credentials, local filesystem paths, or unredacted product screenshots into the site.
- Run `bun run check:docs` after site or docs changes and include desktop plus narrow-mobile browser evidence for user-visible layout changes.

## How content reaches the site

`scripts/generate-docs-manifest.mjs` scans `docs/`, then emits three things into `src/generated/` (gitignored):

- `docs-index.js` — the eager index: route, section, title, `nav_title`, description, `order`. Keep it small; it ships on every page.
- `content/<id>.js` — one module per document holding the markdown **body** (frontmatter already stripped). `docsContent` maps a route to a dynamic import, so opening one page never downloads the rest.
- `search-index.js` — lazily imported by the search dialog only.

Routes come from file paths (`docs/start/install.md` → `/start/install`). That is the logical route. The public href is `/ccmax/start/install`; the file on disk is still `dist/start/install/index.html`. Renaming a file renames its URL, so add the old path to both `LEGACY_ROUTES` in `src/content/docs.js` and `legacyRoutes` in `scripts/prepare-static-output.mjs`.

Sidebar grouping comes from the `sections` array in the generator — register any new top-level `docs/` directory there or it sorts last with a bare directory name. Order inside a group comes from each document's `order` frontmatter.

## Design system

`src/styles/base.css` holds the shared tokens and both themes. The palette is lifted from the desktop app's 「纸·墨·印」 themes — light mirrors 纯白, dark mirrors 墨夜 — so the site and the app read as one product. The landing page carries its own art direction (paper illustrations, ambient video, liquid glass, capsule controls) through a `--wander-*` layer in `src/pages/home/home.css` that binds every entry to a `base.css` token; documentation scopes its reading surfaces through `src/docs/doc-wandor.css`. The public display name is `ccmax`. Rules:

- Use tokens (`--surface-*`, `--text-*`, `--border*`, `--brand*`, `--sp-*`, `--fs-*`, `--r-*`) rather than literal values. A raw hex is a bug everywhere, the landing page included: a page-local palette is an alias onto those tokens, not an exemption.
- The primary button is ink (`--ink`), turning brand (`--brand`) on hover. It is not brand-coloured at rest.
- Depth comes from 1px borders and surface layering, not heavy shadows.
- Keep screenshots flat and legible. Never stack, tilt, blur, or auto-rotate product UI as the main evidence.
- Animation should explain a task stage or reading transition; the page must remain complete with reduced motion or paused motion.
- Both themes must work on every surface, the landing page included — it is not light-only. `data-theme` on `<html>` is set by the bootstrap script in `index.html` before first paint; no stylesheet may pin `color-scheme`, and a page-local palette must bind to tokens whose values differ between the two themes. `src/pages/home/homeTheme.test.js` fails when the landing page drifts from that.
- Breakpoints are 1180 / 900 / 620 across the stylesheets. Do not introduce a fourth.

On a first visit to the site root, show Chinese when the browser's preferred language is Chinese and English for every other language; a saved manual choice wins. Only `/ccmax` and `/ccmax/` split by language — `/ccmax/en` and `/ccmax/en/start` are the English entries, `/ccmax` and `/ccmax/start` stay Chinese, and neither other Pages paths nor language-prefixed URLs are redirected. The rule lives in two places (the inline script in `index.html` and `src/lib/locale.js`) and `scripts/check-docs.mjs` fails when they drift.

## Mermaid

````mermaid fences render as diagrams. Nothing under `docs/` currently uses one — the two pages that did were deleted in the July 2026 restructure — so the dependency and its `.doc-mermaid` styles sit unused, lazily loaded and costing readers nothing. Keep them: `internals/` is exactly where a diagram would earn its place, and the mermaid theme is already wired to the site tokens.

## Fonts

Self-hosted in `public/fonts/`, copied from `desktop/public/fonts/`. **Never add a Google Fonts `@import` or `<link>`** — it is unreachable from mainland China and would leave every heading in a fallback serif. The landing and documentation stylesheets may name `Geist` / `Special Elite` first, but they must keep the self-hosted `Inter` / Noto fallbacks so no page depends on a font CDN. Only the latin subsets are hosted; Chinese glyphs fall through to the platform font on purpose, exactly as the desktop app does.
