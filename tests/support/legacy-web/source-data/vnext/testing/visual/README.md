# vNext visual regression

The harness covers:

1. the component workshop (`/vnext-workshop.html` in the Vite dev server);
2. the shell fixture (`/vnext-shell.html`), expanded / collapsed / tablet / mobile;
3. product screens that have been implemented from their canonical Figma node —
   currently Congressional Staff (`?screen=congressional-staff`, `…-empty`), per the
   baseline rule below.

These HTML files are secondary development fixtures. The production Vite build still uses the canonical `index.html` entry; they are not product routes.

## Capture locally

Build the shared package as required by the web workspace, then start the Vite development server:

```bash
pnpm --filter @capiro/shared build
pnpm --filter @capiro/web dev --host 127.0.0.1 --port 4188
```

In another shell:

```bash
VNEXT_VISUAL_BASE_URL=http://127.0.0.1:4188 \
  pnpm --filter @capiro/web visual:vnext:capture
```

> **Do not use port 4173 on the current dev machine.** It is held by an unrelated
> checkout under `Downloads/`, so Vite fails to bind and the capture silently runs
> against that stale tree instead — which yields confident, wrong conclusions. Sanity
> check the server you actually reached:
> `curl -s http://127.0.0.1:4188/vnext-shell.html | grep -c __CAPIRO_CONFIG__` → `1`.

The capture script drives Chrome over the DevTools Protocol using the repository's existing
`chrome-launcher` dependency plus Node's built-in `WebSocket`, and writes PNGs plus a
SHA-256 manifest under:

```text
apps/web/artifacts/vnext-visual/
```

Expected capture stems are:

```text
component-gallery-desktop.png
shell-desktop-expanded.png
shell-desktop-collapsed.png
shell-tablet.png
shell-mobile.png
directory-congressional-staff.png
directory-congressional-staff-collapsed.png
directory-congressional-staff-empty.png
manifest.json
```

Captures are always PNG, at the exact requested viewport, taken only after
`document.fonts.ready` and two animation frames — text metrics must be final before an
overlay against Figma means anything. `manifest.json` records the filename, viewport,
captured document height and a SHA-256 per capture. The CI workflow
`.github/workflows/web-vnext-foundation.yml` performs the same capture and uploads the
directory as the `web-vnext-foundation-visuals` artifact when GitHub Actions runners are
available. Generated output is gitignored; the manifest hashes are the evidence trail.

### Every target asserts that it rendered

Each target carries an `expect` selector that must be present after load, and the run fails
if it is absent or if the page threw. This is deliberate: the harness previously produced
nothing at all because `VNextComponentWorkshop` rendered `GlobalSearch` (which calls
`useShellOverlay`) with no `ShellOverlayProvider`, so the page threw on mount and never
painted. A capture pipeline without a render assertion will happily write a blank PNG and
let it be mistaken for a passing baseline. **When you add a target, give it a selector that
only exists if the screen truly rendered.**

## Baseline rule

The first successful reviewed capture set becomes the baseline evidence.

Screen implementation has now begun, so the foundation-phase moratorium on product screens
is spent. The rule it leaves behind still stands: **fetch the canonical Figma node first, and
add a screenshot baseline only after the screen is implemented from that node/component
context.** Congressional Staff (`937:2539`) is the first screen to qualify. Do not add a
target for a screen that was built from a description or a screenshot.

To render a product screen here it must be split into a data container and a pure `…View`
(`DashboardVNext`/`DashboardVNextView`, `CongressionalStaffVNext`/`CongressionalStaffVNextView`)
with a fixture under `../fixtures/`. This harness mounts no `ClerkProvider` and issues no API
requests, so a screen that fetches its own data cannot be captured.

## Current validation requirement

A capture harness is not equivalent to a passing visual regression. The implementation handoff must record the actual capture artifact/run and its exact source SHA. If the browser harness cannot execute, foundation acceptance remains blocked rather than being marked green by inspection alone.

Nor is a capture a pixel claim. Producing a PNG and eyeballing it against a Figma frame
establishes structural agreement only. Say "structural side-by-side" unless an actual
numeric overlay was performed, and say which node the comparison was against.
