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

  it('intercepts Dashboard, Portfolio, Strategies, Directory, Program Elements and LegiWatch — the vNext surfaces on os.capiro.ai', () => {
    // Dashboard (`/`), Portfolio (`/clients`), Strategies (`/strategies/*`),
    // Directory (`/directory` + `/directory/congressional-staff`), Program
    // Elements (`/program-elements` + `/program-elements/:peCode`) and LegiWatch
    // (`/legiwatch` + the live hearing room) have native vNext presentations.
    // The Strategies module is a complete native rebuild over the same backend
    // — no old pages/strategy/* components are rendered. Directory claims only
    // the legacy redirect and Congressional Staff in this phase; the remaining
    // list surfaces and all profiles stay canonical. Program Elements reuses
    // the canonical v2 components over the same backend endpoints, re-skinned
    // onto the vNext token layer; the static PE segments (mark-up-monitor,
    // contacts) still fall through to canonical. LegiWatch is the native vNext
    // module (LEGIWATCH-HANDOFF §7): Hearings is the landing tab, removed
    // surfaces (overview, watchlist) redirect to it, and the live hearing room
    // is a full-width route with module chrome suppressed.
    const router = source('./app/VNextRouter.tsx');
    expect(router).toContain("location.pathname === '/'");
    expect(router).toContain("location.pathname === '/strategies'");
    expect(router).toContain("startsWith('/strategies/')");
    expect(router).toContain("location.pathname === '/clients'");
    expect(router).toContain('isVNextDirectoryPath(location.pathname)');
    expect(router).toContain('<VNextDirectoryRoutes />');
    expect(router).toContain('isVNextProgramElementsPath(location.pathname)');
    expect(router).toContain('<VNextProgramElementsRoutes />');
    expect(router).toContain('isVNextLegiWatchPath(location.pathname)');
    expect(router).toContain('<VNextLegiWatchRoutes />');
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

  it('grounds the LegiWatch vNext module in existing intel APIs', () => {
    // The native module (LEGIWATCH-HANDOFF §7) replaces the prior Figma bridge
    // page. It reads the canonical intel feed, upcoming-hearings and tracker
    // endpoints through the module's own hooks — never a mock, never a new
    // backend (§1.2), and never the old Radar page (§11.2 is read, not copied).
    const mod = source('./pages/legiwatch/LegiWatchModule.tsx');
    const api = source('./pages/legiwatch/lib/api.ts');
    const hearings = source('./pages/legiwatch/hearings/HearingsTab.tsx');
    expect(api).toContain('intelFeedPaths.tenantFeed');
    expect(api).toContain('intelFeedPaths.feed');
    expect(hearings).toContain('useUpcomingHearings');
    expect(mod).not.toContain('<RadarPage />');
    // Hearings is the landing tab; removed surfaces redirect to it (§7.2/§7.9).
    expect(mod).toContain("REMOVED_TABS");
    expect(mod).toContain("'hearings'");
  });

  it('does not ship ephemeral Figma image endpoints into vNext implementation code', () => {
    const files = [
      './pages/strategies/StrategyLibraryVNext.tsx',
      './pages/strategies/StrategyEditorVNext.tsx',
      './pages/strategies/VNextStrategiesRoutes.tsx',
      './pages/legiwatch/LegiWatchModule.tsx',
      './shell/TopBar/index.tsx',
    ].map(source).join('\n');
    expect(files).not.toMatch(/figmausercontent|s3-alpha-sig|amazonaws\.com\/figma/i);
  });

  it('keeps the Dashboard nav exact so it cannot stay selected on every route', () => {
    const sidebar = source('./shell/Sidebar/index.tsx');
    expect(sidebar).toContain("end={item.path === '/'}");
  });
});
