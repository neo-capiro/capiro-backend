# Capiro vNext Figma implementation boundary

This directory records the canonical design sources for the isolated `WEB_SURFACE=vnext` frontend. It is documentation and mapping metadata; it is not a generated-code dump.

## Canonical files

- Capiro: `2aa9ipR2qOfumaixZErCfU` — **Capiro Design System v3 — Premium Intelligence Platform**
- Untitled vendor reference: `6NmsN8HSqbwJ0VjJvTYDtR` — **Untitled UI v8 — Vendor Source**

Untitled is a structural/accessibility reference only. Capiro owns typography, color, density, radius, elevation, navigation architecture and branded treatment.

## Canonical app shell

- Page: `721:2502`
- Desktop expanded: `722:2502`
- Desktop collapsed: `723:2530`
- Interaction/submenu states: `725:2560`

The expanded shell was retrieved with Figma design context while building this foundation. Its semantic tokens are represented under `vnext/foundations/`; the generated Tailwind reference was not copied and Tailwind was not added.

The implementation handoff specifies **Hanken Grotesk** for product UI, **IBM Plex Mono** for metadata/codes/evidence, and **Source Serif 4** for editorial/client artifacts. The expanded Figma node contains concrete Hanken Grotesk text layers while one inherited `--capiro-type-family-sans` variable currently reports `Instrument Sans`. The vNext CSS therefore follows the approved handoff/concrete shell layers and uses Hanken first, with Instrument Sans as a fallback. This mismatch should be reconciled in the Figma variable collection before page implementation.

## Canonical Dashboard

- Page: `748:2502`
- Expanded: `751:2502`
- Collapsed: `753:2532`

## Canonical Program Elements

- Page: `768:2502`
- Explore: `773:2956`
- Movement: `775:2532`
- Congressional: `776:2545`
- Actions: `777:2558`
- Portfolio: `778:2603`
- Profile Overview: `780:2644`
- Funding & Lifecycle: `782:2663`
- Legislative: `783:2679`
- Program Structure: `784:2701`
- Sources & Proof: `785:2717`
- Implementation handoff: `788:2765`

These product screens are intentionally **not implemented in the foundation phase**.

## Design-to-code rules

1. Fetch the target node with Figma design context before implementation.
2. Treat returned React/Tailwind as reference material, never production code.
3. Map Figma objects to existing vNext primitives before creating anything new.
4. Preserve existing Capiro hooks, routes, feature gates and API calls unless the product behavior is intentionally changing.
5. Keep all vNext styling below `.capiro-vnext-root`; no global Ant, element or body overrides.
6. Do not add Tailwind solely because Figma reference code uses Tailwind utilities.
7. Responsive variants are implemented from their own Figma frames, not by shrinking desktop layouts.
8. Screenshots are validation references; node/component context is the implementation source.
9. Do not persist short-lived Figma MCP asset URLs in committed product code. Export exact assets when a later screen requires them.

## Code Connect inventory

The authoritative mapping inventory lives in `manifest.ts`. Code Connect publication is intentionally deferred; the foundation creates stable React targets first. Current targets include Button/Main → `CapiroButton`, Shell/MeriLauncher → `MeriLauncher`, Shell/Search → `GlobalSearch`, Mailbox Sync → `MailboxSyncStatus`, Status/Badge → `CapiroBadge`, and the seven intelligence visualization boundaries under `vnext/intelligence/`.

## Route gaps

`vnext/adapters/routes/routeManifest.ts` reuses the existing registered routes. Dedicated list routes were not found for the requested Directory children **Congressional Staff**, **Committee Staff**, or **Department of War**, so they are explicitly recorded as gaps instead of being redirected to unrelated URLs.
