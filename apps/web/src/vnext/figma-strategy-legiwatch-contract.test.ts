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

  it('intercepts only approved vNext presentation routes', () => {
    const router = source('./app/VNextRouter.tsx');
    expect(router).toContain("location.pathname === '/strategies'");
    expect(router).toContain("location.pathname === '/legiwatch'");
    expect(router).toContain('<Outlet />');
  });

  it('grounds Strategy vNext surfaces in production hooks rather than mock data', () => {
    const library = source('./pages/strategies/StrategyLibraryVNext.tsx');
    const contextLibrary = source('./pages/strategies/StrategyContextLibraryVNext.tsx');
    const contextDocument = source('./pages/strategies/StrategyContextDocumentVNext.tsx');

    expect(library).toContain('useStrategies()');
    expect(library).toContain('useFirmPhases()');
    expect(library).toContain('data-figma-node="843:2502"');
    expect(contextLibrary).toContain('useContextDocuments()');
    expect(contextLibrary).toContain('useContextFacts()');
    expect(contextLibrary).toContain('useContextConflicts()');
    expect(contextLibrary).toContain('data-figma-node="843:2976"');
    expect(contextDocument).toContain('useContextLocate(id, activeRef)');
    expect(contextDocument).toContain('useExtractContextFacts()');
    expect(contextDocument).toContain('data-figma-node="843:3134"');
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
      './pages/strategies/StrategyContextLibraryVNext.tsx',
      './pages/strategies/StrategyContextDocumentVNext.tsx',
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

describe('vNext route mounting', () => {
  it('re-bases the Strategies family so its index route can match', () => {
    // Regression, caught on os.capiro.ai: VNextApp renders outside the
    // canonical route tree, so VNextStrategiesRoutes' descendant <Routes>
    // resolved against "/" and its `:id` route swallowed "strategies",
    // rendering "This strategy could not be loaded" instead of the library.
    expect(source('./app/VNextRouter.tsx')).toContain('path="strategies/*"');
  });
});
