# vNext foundation visual regression

The foundation visual harness intentionally covers only:

1. the component workshop (`/vnext-workshop.html` in the Vite dev server);
2. the empty shell fixture (`/vnext-shell.html`).

These HTML files are secondary development fixtures. The production Vite build still uses the canonical `index.html` entry; they are not product routes.

## Capture locally

Build the shared package as required by the web workspace, then start the Vite development server:

```bash
pnpm --filter @capiro/shared build
pnpm --filter @capiro/web dev --host 127.0.0.1 --port 4173
```

In another shell:

```bash
VNEXT_VISUAL_BASE_URL=http://127.0.0.1:4173 \
  pnpm --filter @capiro/web visual:vnext:capture
```

The capture script reuses the repository's existing `lighthouse` + `chrome-launcher` dev dependencies and writes PNGs plus a SHA-256 manifest under:

```text
apps/web/artifacts/vnext-visual/
```

Expected captures:

```text
component-gallery-desktop.png
shell-desktop-expanded.png
shell-desktop-collapsed.png
shell-tablet.png
shell-mobile.png
manifest.json
```

The CI workflow `.github/workflows/web-vnext-foundation.yml` performs the same capture and uploads the directory as the `web-vnext-foundation-visuals` artifact when GitHub Actions runners are available.

## Baseline rule

For the foundation phase, the first successful reviewed capture set becomes the baseline evidence. Do not add Dashboard, Program Elements, Client Profile, Engagement Manager or other product-screen screenshots to this harness yet.

When future screen implementation begins, fetch the canonical Figma node first and add a screenshot baseline only after the screen is implemented from that node/component context.

## Current validation requirement

A capture harness is not equivalent to a passing visual regression. The implementation handoff must record the actual capture artifact/run and its exact source SHA. If the browser harness cannot execute, foundation acceptance remains blocked rather than being marked green by inspection alone.
