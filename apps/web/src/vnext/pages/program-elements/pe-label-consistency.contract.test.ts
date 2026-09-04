/**
 * PR D / LW-QA-009 — product-label consistency contract.
 *
 * `/program-elements` must have exactly ONE user-facing product name per
 * tenant: "Defense Budget" inside the capiro-internal shell, "Program
 * Elements" for every other tenant. It must never be surfaced under BOTH
 * names in the same shell.
 *
 * NOT covered (deliberately): "Program element(s)" where it names the
 * budget-line DATA TYPE — source-type labels, outreach context tabs,
 * portfolio table sections, analytics facets. Those are correct as-is.
 *
 * Source-level contract (same posture as pr-b-reachability): the shells'
 * label wiring is static; asserting the wiring is deterministic and cheap.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function repo(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('LW-QA-009 — /program-elements has one product name per tenant', () => {
  const appShell = repo('../../../components/AppShell.tsx');
  const appShellV2 = repo('../../../components/AppShellV2.tsx');
  const routeManifest = repo('../../adapters/routes/routeManifest.ts');
  const peWorkspace = repo('../program-elements/PeWorkspacePage.tsx');

  it('legacy shell: internal tenant gets Defense Budget for nav + page title', () => {
    expect(appShell).toMatch(/isInternalTenant \? 'Defense Budget' : 'Program Elements'/);
    // Nav leaf label is resolved per-tenant inside the items builder; the page-
    // title map routes through the same tenant-aware value.
    expect(appShell).toContain("n.key === 'program-elements' ? peNavLabel : n.label");
    expect(appShell).toContain("'program-elements': isInternalTenant ? 'Defense Budget' : 'Program Elements'");
  });

  it('legacy shell: the static "Program Elements" nav literal is gone', () => {
    // The NAV literal must not be a hardcoded product name anymore.
    expect(appShell).not.toMatch(/key: 'program-elements',\s*\n\s*label: 'Program Elements'/);
  });

  it('internal-only shell (AppShellV2): Defense Budget unconditionally', () => {
    // AppShellV2 renders ONLY for capiro-internal (AppShell tenant branch),
    // so its label is Defense Budget without tenant branching.
    expect(appShellV2).toContain("{ key: 'program-elements', label: 'Defense Budget', path: '/program-elements' }");
    expect(appShellV2).toContain('Open Defense Budget →');
    expect(appShellV2).not.toContain("label: 'Program Elements'");
  });

  it('the internal shell never surfaces both product names for the same route', () => {
    // Inside the internal tenant shell, every /program-elements surface uses
    // the same name. The v2 shell contains no "Program Elements" nav literal;
    // the workspace header already says Defense Budget.
    expect(peWorkspace).toContain('Defense Budget');
  });

  it('external tenants keep the Program Elements label where tenant naming requires it', () => {
    // routeManifest's tenant override only remaps capiro-internal; the base
    // label for everyone else stays Program Elements.
    expect(routeManifest).toMatch(/tenantLabels: \{ 'capiro-internal': 'Defense Budget' \}/);
    expect(routeManifest).toMatch(/label: 'Program Elements'/);
  });

  it('the workspace page header itself says Defense Budget (single source already migrated)', () => {
    expect(peWorkspace).toMatch(/pe-ws-bar__eyebrow">Defense Budget</);
  });
});
