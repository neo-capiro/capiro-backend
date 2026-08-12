import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('os.capiro.ai Figma Strategies + LegiWatch contract', () => {
  it('keeps the canonical Figma node inventory explicit', () => {
    const manifest = source('./figma/manifest.ts');
    for (const node of [
      '843:2502',
      '843:2660',
      '843:2818',
      '843:2976',
      '843:3134',
      '843:3292',
      '843:3450',
      '843:3608',
      '869:2502',
      '869:2705',
      '869:2908',
      '869:3111',
      '869:3314',
      '869:3517',
      '869:3720',
      '869:3923',
      '869:4126',
      '869:4329',
      '888:2593',
      '889:2593',
      '890:2593',
    ]) {
      expect(manifest).toContain(`'${node}'`);
    }
  });

  it('intercepts Dashboard, Portfolio, Strategies, Directory and Program Elements — the vNext surfaces on os.capiro.ai', () => {
    // Dashboard (`/`), Portfolio (`/clients`), Strategies (`/strategies/*`),
    // Directory (`/directory` + `/directory/congressional-staff`) and Program
    // Elements (`/program-elements` + `/program-elements/:peCode`) have native
    // vNext presentations. The Strategies module is a complete native rebuild
    // over the same backend — no old pages/strategy/* components are rendered.
    // Directory claims only the legacy redirect and Congressional Staff in this
    // phase; the remaining list surfaces and all profiles stay canonical.
    // Program Elements reuses the canonical v2 components over the same backend
    // endpoints, re-skinned onto the vNext token layer; the static PE segments
    // (mark-up-monitor, contacts) still fall through to canonical.
    // LegiWatch still falls through to canonical.
    const router = source('./app/VNextRouter.tsx');
    expect(router).toContain("location.pathname === '/'");
    expect(router).toContain("location.pathname === '/strategies'");
    expect(router).toContain("startsWith('/strategies/')");
    expect(router).not.toContain("location.pathname === '/legiwatch'");
    expect(router).toContain("location.pathname === '/clients'");
    expect(router).toContain('isVNextDirectoryPath(location.pathname)');
    expect(router).toContain('<VNextDirectoryRoutes />');
    expect(router).toContain('isVNextProgramElementsPath(location.pathname)');
    expect(router).toContain('<VNextProgramElementsRoutes />');
    expect(router).toContain('<Outlet />');
  });

  it('grounds Strategy vNext surfaces in production hooks rather than mock data', () => {
    const library = source('./pages/strategies/StrategyLibraryVNext.tsx');
    const editor = source('./pages/strategies/StrategyEditorVNext.tsx');
    const routes = source('./pages/strategies/VNextStrategiesRoutes.tsx');

    expect(library).toContain('useStrategies()');
    expect(library).toContain('useFirmPhases()');
    expect(editor).toContain('useStrategy(');
    expect(editor).toContain('useReferenceCalendars()');
    expect(editor).toContain('useFirmPhases()');
    // The module never renders an old strategy component.
    for (const file of [library, editor, routes]) {
      expect(file).not.toMatch(/pages\/strategy\/(StrategyEditorPage|StrategyLibraryPage|StrategyTimeline)/);
      expect(file).not.toMatch(/pages\/strategy\/agents\/(ReviewQueue|ExecutionReview)/);
      expect(file).not.toMatch(/pages\/strategy\/context\/(StewardReview|ContextLibrary|ContextDocumentView)/);
    }
  });

  it('grounds LegiWatch overview, digest and analytics in existing intel APIs', () => {
    const legiwatch = source('./pages/legiwatch/VNextLegiWatchPage.tsx');
    expect(legiwatch).toContain('intelFeedPaths.tenantFeed()');
    expect(legiwatch).toContain("'/intel-api/upcoming-hearings'");
    expect(legiwatch).toContain('<RadarPage />');
    expect(legiwatch).toContain('data-figma-node="869:2502"');
    expect(legiwatch).toContain('data-figma-node="869:4126"');
    expect(legiwatch).toContain('data-figma-node="869:4329"');
  });

  it('does not ship ephemeral Figma image endpoints into vNext implementation code', () => {
    const files = [
      './pages/strategies/StrategyLibraryVNext.tsx',
      './pages/strategies/StrategyEditorVNext.tsx',
      './pages/strategies/VNextStrategiesRoutes.tsx',
      './pages/legiwatch/VNextLegiWatchPage.tsx',
      './shell/TopBar/index.tsx',
    ].map(source).join('\n');
    expect(files).not.toMatch(/figmausercontent|s3-alpha-sig|amazonaws\.com\/figma/i);
  });

  it('keeps the Dashboard nav exact so it cannot stay selected on every route', () => {
    const sidebar = source('./shell/Sidebar/index.tsx');
    expect(sidebar).toContain("end={item.path === '/'}");
  });
});
