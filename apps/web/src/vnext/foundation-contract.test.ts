import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VNEXT_ROUTE_GAPS,
  VNEXT_ROUTE_MANIFEST,
  visibleVNextRoutes,
} from './adapters/routes/routeManifest.js';

const cssFiles = [
  './foundations/tokens.css',
  './foundations/reset.css',
  './foundations/typography.css',
  './foundations/elevation.css',
  './foundations/responsive.css',
  './components/primitives.css',
  './shell/shell.css',
  './pages/dashboard/dashboard.css',
  './pages/directory/directory.css',
  './pages/legiwatch/legiwatch.css',
  './pages/strategies/strategies-tokens.css',
  './pages/strategies/strategies.css',
  './pages/strategies/strategy-library.css',
  './pages/strategies/strategy-editor.css',
  './pages/strategies/step-inspector.css',
];

const componentCssFiles = [
  './components/primitives.css',
  './shell/shell.css',
  './pages/dashboard/dashboard.css',
  './pages/directory/directory.css',
];

/**
 * Vite rewrites `new URL('<string literal>', import.meta.url)` into an asset URL
 * (`http://localhost:3000/...`), which `readFileSync` rejects. Resolving from the
 * package root keeps these repository-contract assertions reading real files.
 */
function fromPackageRoot(relativePath: string): string {
  return resolve(process.cwd(), relativePath);
}

/** The CSS lists above are written relative to this directory. */
function fromVNext(relativePath: string): string {
  return resolve(process.cwd(), 'src/vnext', relativePath);
}

describe('vNext foundation contract', () => {
  it('keeps vNext styling below the capiro-vnext root instead of global element/Ant overrides', () => {
    for (const path of cssFiles) {
      const css = readFileSync(fromVNext(path), 'utf8');
      expect(css).toContain('.capiro-vnext-root');
      expect(css).not.toMatch(/(^|\n)\s*(body|html)\b/);
      expect(css).not.toMatch(/(^|\n)\s*\.ant-[\w-]+/);
    }
  });

  it('keeps visual color literals in the semantic token layer rather than component CSS', () => {
    for (const path of componentCssFiles) {
      const css = readFileSync(fromVNext(path), 'utf8');
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(css).not.toMatch(/rgba?\s*\(/i);
    }
  });

  it('uses existing shell destinations and registers every Directory surface', () => {
    expect(VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'dashboard')?.path).toBe('/');
    expect(VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'portfolio')?.path).toBe('/clients');

    // The three Directory destinations were gaps until the Directory vNext split
    // (Figma 941:2860) registered them, and State Legislators joined them as a
    // fourth first-class surface. A gap here again would mean the shell is
    // linking to a destination that no longer resolves.
    const directory = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'directory');
    expect(directory?.children?.map((route) => route.path)).toEqual([
      '/directory/congressional-staff',
      '/directory/committee-staff',
      '/directory/department-of-war',
      '/directory/state-legislators',
    ]);
    expect(VNEXT_ROUTE_GAPS.map((route) => route.id)).toEqual([]);
    // The gap mechanism itself is still intact for future unresolved routes.
    expect(VNEXT_ROUTE_GAPS.every((route) => route.path === null)).toBe(true);
  });

  it('preserves canonical feature visibility instead of exposing gated navigation by default', () => {
    const withoutFlags = visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, {});
    expect(withoutFlags.some((route) => route.id === 'strategies')).toBe(false);
    const intelligenceWithoutFlags = withoutFlags.find((route) => route.id === 'intelligence');
    expect(intelligenceWithoutFlags?.children?.map((route) => route.id)).not.toContain('funding-opportunities');
    expect(intelligenceWithoutFlags?.children?.map((route) => route.id)).not.toContain('district-nexus');

    const withFlags = visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, {
      meFeatures: { strategyPlanner: true },
      featureFlags: { funding_opportunities: true, district_nexus_v2: true },
    });
    expect(withFlags.some((route) => route.id === 'strategies')).toBe(true);
    const intelligenceWithFlags = withFlags.find((route) => route.id === 'intelligence');
    expect(intelligenceWithFlags?.children?.map((route) => route.id)).toEqual(
      expect.arrayContaining(['funding-opportunities', 'district-nexus']),
    );
  });

  it('selects vNext lazily after shared billing gates and preserves the canonical AppShell fallback', () => {
    const app = readFileSync(fromPackageRoot('src/App.tsx'), 'utf8');
    const vnextApp = readFileSync(fromPackageRoot('src/vnext/app/VNextApp.tsx'), 'utf8');
    expect(app).toContain("import('./vnext/app/VNextApp.js')");
    expect(app).not.toContain("from './vnext/foundations");
    expect(app).toContain('if (isVNextSurface)');
    expect(app).toContain('<VNextApp />');
    expect(app).toContain('return <AppShell />;');
    expect(vnextApp).toContain("import '../foundations/index.css';");
    expect(app.indexOf('if (isVNextSurface)')).toBeGreaterThan(app.indexOf('if (data?.billingEnabled && data.locked)'));
  });

  it('injects WEB_SURFACE only through the isolated WebVNext stack and exposes release identity', () => {
    const stack = readFileSync(
      fromPackageRoot('../../infra/cdk/lib/web-vnext-stack.ts'),
      'utf8',
    );
    const entrypoint = readFileSync(fromPackageRoot('nginx/entrypoint.sh'), 'utf8');
    expect(stack).toContain("WEB_SURFACE: 'vnext'");
    expect(stack).toContain('CAPIRO_WEB_RELEASE_SHA: props.releaseSha');
    expect(entrypoint).toContain("webSurface: '${WEB_SURFACE_VALUE}'");
    expect(entrypoint).toContain("releaseSha: '${WEB_RELEASE_SHA}'");
  });
});
