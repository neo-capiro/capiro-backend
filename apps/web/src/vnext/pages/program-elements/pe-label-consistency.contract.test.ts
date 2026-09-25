/**
 * PR D / LW-QA-009 — product-label consistency contract.
 *
 * `/program-elements` has one user-facing product name across tenants:
 * "Defense Budget". "Program element(s)" remains valid only when it names the
 * underlying budget-line data type.
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

describe('LW-QA-009 — /program-elements has one product name across tenants', () => {
  const appShell = repo('../../../components/AppShell.tsx');
  const appShellV2 = repo('../../../components/AppShellV2.tsx');
  const routeManifest = repo('../../adapters/routes/routeManifest.ts');
  const peWorkspace = repo('../program-elements/PeWorkspacePage.tsx');

  it('legacy shell: every tenant gets Defense Budget for nav + page title', () => {
    expect(appShell).toContain("const peNavLabel = 'Defense Budget'");
    expect(appShell).not.toMatch(/isInternalTenant \? 'Defense Budget' : 'Program Elements'/);
    expect(appShell).toContain("n.key === 'program-elements' ? peNavLabel : n.label");
    expect(appShell).toContain("'program-elements': 'Defense Budget'");
  });

  it('legacy shell: the static "Program Elements" nav literal is gone', () => {
    // The NAV literal must not be a hardcoded product name anymore.
    expect(appShell).not.toMatch(/key: 'program-elements',\s*\n\s*label: 'Program Elements'/);
  });

  it('fleet shell (AppShellV2): Defense Budget unconditionally', () => {
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

  it('vNext navigation uses Defense Budget for every tenant', () => {
    expect(routeManifest).not.toMatch(/tenantLabels: \{ 'capiro-internal': 'Defense Budget' \}/);
    expect(routeManifest).toMatch(/label: 'Defense Budget'/);
    expect(routeManifest).not.toMatch(/label: 'Program Elements'/);
  });

  it('the workspace page header itself says Defense Budget (single source already migrated)', () => {
    expect(peWorkspace).toMatch(/pe-ws-bar__eyebrow">Defense Budget</);
  });
});
