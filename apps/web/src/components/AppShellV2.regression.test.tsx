// Regression tests for the three AppShellV2 / Dashboard defects fixed on main:
//  P0  /?meriWindow=1 must render the Meri workspace, not AppShellV2
//  P1  Dashboard (section 'dashboard') hides the client selector + clears scope
//  P1  Dashboard meeting actions carry the DS v2 classes
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sectionFor } from './AppShellV2.js';

const COMPONENTS = resolve(__dirname);
const appShell = readFileSync(resolve(COMPONENTS, 'AppShell.tsx'), 'utf8');
const v2 = readFileSync(resolve(COMPONENTS, 'AppShellV2.tsx'), 'utf8');
const home = readFileSync(resolve(COMPONENTS, '../pages/HomePage.tsx'), 'utf8');
const theme = readFileSync(resolve(COMPONENTS, '../theme.css'), 'utf8');

describe('P0 — Meri workspace popup bypasses the app shell', () => {
  it('AppShell returns MeriOverlay for ?meriWindow=1 BEFORE the capiro-internal branch', () => {
    const meriIdx = appShell.indexOf('if (isMeriWorkspaceWindow())');
    const v2Idx = appShell.indexOf("tenant.slug === 'capiro-internal'");
    expect(meriIdx).toBeGreaterThan(-1);
    expect(v2Idx).toBeGreaterThan(-1);
    // The Meri early-return must precede the AppShellV2 gate in source order.
    expect(meriIdx).toBeLessThan(v2Idx);
    expect(appShell).toContain('return <MeriOverlay');
  });

  it('sectionFor maps dashboard/intelligence/engagement correctly', () => {
    expect(sectionFor('/')).toBe('dashboard');
    expect(sectionFor('/engagement')).toBe('engagement');
    expect(sectionFor('/engagement/meetings/1')).toBe('engagement');
    expect(sectionFor('/program-elements')).toBe('intelligence');
    expect(sectionFor('/clients')).toBe('portfolio');
  });
});

describe('P1 — Dashboard client selector', () => {
  it('AppShellV2 hides the CLIENT control on the dashboard section only', () => {
    expect(v2).toContain("section !== 'dashboard'");
    // The clear-on-entry effect that strips an invisible client scope.
    expect(v2).toContain("section === 'dashboard' && selectedClientId");
    expect(v2).toContain('setSelectedClientId(null)');
  });
});

describe('P1 — Dashboard meeting-action DS v2 classes', () => {
  it('HomePage passes the dash-send-meri hook to SendMeriButton', () => {
    expect(home).toContain('className="dash-send-meri"');
  });
  it('theme.css carries the scoped v2 overrides for both buttons', () => {
    expect(theme).toContain('.v2-root .dash-btn-soft');
    expect(theme).toContain('.v2-root .dash-send-meri');
    // Ink primary + neutral secondary per the DS v2 spec.
    expect(theme).toMatch(/\.v2-root \.dash-send-meri \{[^}]*#131A24/s);
    expect(theme).toMatch(/\.v2-root \.dash-btn-soft \{[^}]*#C3CBD7/s);
  });
});
