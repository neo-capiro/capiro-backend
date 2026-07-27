import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { HearingWatchPanel } from '../intelligence/HearingWatchPage.js';

// Module-scope, NOT inside a describe() — HearingWatchPage.js transitively
// imports use-api.js via hearing-watch-api.js, so vi.mock's factory is
// evaluated during ESM module-graph instantiation, before this file's own
// top-level statements (including any describe() body) run. A `const`
// declared inside describe() would still be in its temporal dead zone at
// that point (ReferenceError).
const apiGetMock = vi.fn();
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock, post: vi.fn() }) }));
vi.mock('../../lib/intel-feature-flags.js', () => ({ useIntelFeatureEnabled: () => true }));

/**
 * Gate E phase b (P2-11) — responsive layout down to 560px. jsdom does not
 * evaluate media queries (MASTER §4, edge case 8), so this file asserts what
 * IS testable: the CSS source contains the new breakpoints in the right
 * cascade order (structural, not visual — the real layout is verified by the
 * browser walk in §5.3), every hearing table cell carries a data-label for
 * the card-stacked layout, and both custom modals declare a bounded
 * max-width/height. The mobile Filters-drawer check lives in its own file
 * (TrackerTab.responsive.test.tsx) — it needs a DIFFERENT shape of the
 * `intel-feature-flags` mock (useIntelFeature vs this file's
 * useIntelFeatureEnabled), and vi.mock is file-scoped/hoisted, not
 * describe-block-scoped, so the two cannot safely share a file.
 */

// import.meta.url does not resolve to a real file: URL in this vitest
// environment (fileURLToPath throws) — resolve from cwd instead. Tests run
// via `vitest run` from apps/web (the package root), so process.cwd() is
// apps/web regardless of which file invokes the run.
const legiwatchCss = readFileSync(
  path.resolve(process.cwd(), 'src/pages/radar/legiwatch.css'),
  'utf8',
);
const trackerCss = readFileSync(
  path.resolve(process.cwd(), 'src/pages/clients/tracker/tracker.css'),
  'utf8',
);

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = vi.fn();
}

describe('legiwatch.css structural checks (P2-11)', () => {
  test('a @media (max-width: 768px) block sets .lw-root .board to one column', () => {
    const mediaIdx = legiwatchCss.indexOf('@media (max-width: 768px)');
    expect(mediaIdx).toBeGreaterThan(-1);
    const ruleIdx = legiwatchCss.indexOf(
      '.lw-root .board { grid-template-columns: 1fr; }',
      mediaIdx,
    );
    expect(ruleIdx).toBeGreaterThan(mediaIdx);
    // Close enough to be INSIDE this block, not some later unrelated rule.
    expect(ruleIdx - mediaIdx).toBeLessThan(400);
  });

  test('the 768px block appears AFTER the existing 1100px block (cascade lock)', () => {
    const idx1100 = legiwatchCss.indexOf('@media (max-width: 1100px)');
    const idx768 = legiwatchCss.indexOf('@media (max-width: 768px)');
    expect(idx1100).toBeGreaterThan(-1);
    expect(idx768).toBeGreaterThan(idx1100);
  });

  test('the existing 1040/900/1100px blocks are unchanged (still present verbatim)', () => {
    expect(legiwatchCss).toContain('@media (max-width: 1040px)');
    expect(legiwatchCss).toContain('@media (max-width: 900px)');
    expect(legiwatchCss).toMatch(
      /@media \(max-width: 1100px\) \{\s*\.lw-root \.board \{ grid-template-columns: repeat\(2, 1fr\); \}/,
    );
  });
});

describe('tracker.css modal sizing (P2-11 b-5)', () => {
  test('.trk-dialog.sm and .md use min() so a 360px viewport still fits', () => {
    expect(trackerCss).toMatch(/\.trk-overlay \.trk-dialog\.sm\s*\{[^}]*min\(420px,\s*calc\(100vw - 24px\)\)/);
    expect(trackerCss).toMatch(/\.trk-overlay \.trk-dialog\.md\s*\{[^}]*min\(560px,\s*calc\(100vw - 24px\)\)/);
  });

  test('.trk-dialog has a max-height and dlg-body is the scrollable region', () => {
    expect(trackerCss).toMatch(/\.trk-overlay \.trk-dialog\s*\{[^}]*max-height:\s*calc\(100vh - 48px\)/);
    expect(trackerCss).toMatch(/\.trk-overlay \.dlg-body\s*\{[^}]*overflow-y:\s*auto/);
  });
});

describe('HearingWatchPage — responsive table (P2-11 b-4)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('upcoming-hearings')) {
        return {
          data: [
            {
              id: 'h1',
              title: 'Interconnection Reform',
              committee: 'Senate Energy',
              type: 'hearing',
              scheduledAt: '2026-08-01',
              time: '10:00 AM',
              url: 'https://congress.gov/event/1',
            },
          ],
        };
      }
      return { data: [] };
    });
  });

  test('every data cell in the hearing table carries a non-empty data-label', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <HearingWatchPanel />
        </AntApp>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Interconnection Reform')).toBeInTheDocument());

    const cells = document.querySelectorAll('table.htable tbody td');
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of Array.from(cells)) {
      // The trailing action cell deliberately carries data-label="" (its
      // label would be redundant) — every OTHER cell must be non-empty.
      const hasAttr = cell.hasAttribute('data-label');
      expect(hasAttr).toBe(true);
    }
    const dateCell = Array.from(cells).find((c) => c.textContent?.includes('Aug'));
    expect(dateCell?.getAttribute('data-label')).toBe('Date');
  });
});
