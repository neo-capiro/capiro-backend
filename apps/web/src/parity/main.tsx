/*
 * Phase 7 visual-parity harness entry. DEV/QA ONLY — served by
 * vite.parity.config.ts via parity.html; never part of a product build.
 *
 * What it mounts is production: the real StrategyLibraryPage /
 * StrategyEditorPage (and through them the real header, timeline, Meri panel,
 * Watch panel, chat thread and composer), the real api.ts hooks, the real
 * design-system CSS and the real antd theme (ANTD_THEME, shared with main.tsx).
 * Only the axios transport and Clerk are stubbed.
 *
 * States are reached by DRIVING THE REAL UI (clicking Ask Meri, deep-linking
 * ?node=, clicking Why?, clicking Accept against a hung request) rather than by
 * passing the components a special prop — a state that needed a harness-only
 * prop would not be evidence of anything.
 *
 * `window.__parityReady` flips true once the requested state is fully settled,
 * so the capture script has a deterministic wait condition instead of a sleep.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App as AntApp, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ANTD_THEME } from '../theme-antd.js';
import { StrategyLibraryPage } from '../pages/strategy/StrategyLibraryPage.js';
import { StrategyEditorPage } from '../pages/strategy/StrategyEditorPage.js';
import { parityState } from './state.js';
import { SID } from './fixtures.js';
import '../theme.css';
import '../pages/strategy/strategy-ds.css';

declare global {
  interface Window {
    __parityReady?: boolean;
    __parityError?: string;
  }
}

const s = parityState();

const queryClient = new QueryClient({
  defaultOptions: {
    // Same shape as production's, minus retry (a harness must fail loudly).
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
    mutations: { retry: false },
  },
});

const root = document.getElementById('parity-root')!;
// `?shell=app` swaps the prototype's content-region box for PRODUCTION's own
// geometry (52px topbar, 232px sider) and wraps the tree in `.app-content`, so
// the only thing that can bound the page is the real theme.css rule. That is
// how the F1 fix is verified without a deploy — see parity.html.
const shellMode = new URLSearchParams(location.search).get('shell') === 'app';
if (shellMode) root.classList.add('shell-app');
Object.assign(root.style, {
  left: `${shellMode ? 232 : s.box.x}px`,
  top: `${shellMode ? 52 : s.box.y}px`,
  width: `${shellMode ? window.innerWidth - 232 : s.box.w}px`,
  height: `${shellMode ? window.innerHeight - 52 : s.box.h}px`,
  // The prototype's content column background.
  background: 'var(--bg-canvas, #F4F2EC)',
  display: 'flex',
  flexDirection: 'column',
});

// The editor's step deep-link is production behaviour (?node=<id> selects the
// step and opens the panel), so the step-thread state uses it rather than a
// synthetic click.
const entry =
  s.name === 'list'
    ? '/strategies'
    : s.selectNodeId
      ? `/strategies/${SID}?node=${s.selectNodeId}`
      : `/strategies/${SID}`;

/**
 * In `?shell=app` the tree is wrapped in antd's `.app-content` class, which is
 * the element production's `.app-content:has(.sp-editor-shell)` rule targets.
 * Otherwise the tree mounts bare, as every other parity state expects.
 */
function ShellWrap({ children }: { children: React.ReactNode }) {
  if (!shellMode) return <>{children}</>;
  return (
    <div className="app-content" style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>
  );
}

ReactDOM.createRoot(root).render(
  // NOT StrictMode: its double-invoke makes post-layout effects (center-today)
  // run twice, which is exactly what a screenshot must not depend on.
  <ConfigProvider theme={ANTD_THEME}>
    <AntApp>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <ShellWrap>
            {/* Exactly what StrategyRoutes renders in production. */}
            <div className="sp-root" style={{ height: '100%', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <Routes>
                <Route path="/strategies" element={<StrategyLibraryPage />} />
                <Route path="/strategies/:id" element={<StrategyEditorPage />} />
              </Routes>
            </div>
          </ShellWrap>
        </MemoryRouter>
      </QueryClientProvider>
    </AntApp>
  </ConfigProvider>,
);

// ---- post-mount driver ---------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function byName(name: string | RegExp): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')];
  const match = (el: HTMLElement) => {
    const text = `${el.getAttribute('aria-label') ?? ''} ${el.innerText ?? ''}`.trim();
    return typeof name === 'string' ? text.includes(name) : name.test(text);
  };
  return all.find(match) ?? null;
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(60);
  }
  return false;
}

async function drive(): Promise<void> {
  await document.fonts.ready;

  if (s.name === 'list') {
    await waitFor(() => document.body.innerText.includes('YOUR STRATEGIES'));
    return;
  }

  await waitFor(() => Boolean(document.querySelector('[data-testid="sp-header"]')));

  if (s.openPanel && !s.selectNodeId) {
    const cta = byName('Ask Meri') ?? byName('Edit panel');
    cta?.click();
  }
  if (s.openPanel || s.selectNodeId) {
    await waitFor(() => Boolean(document.querySelector('[data-testid="sp-panel-body"]')));
  }
  if (s.watcher && s.openPanel && !s.selectNodeId) {
    await waitFor(() => Boolean(document.querySelector('[data-testid="sp-watch-panel"]')));
  }

  if (s.name === 'watch-why') {
    await waitFor(() => Boolean(byName('Why?')));
    byName('Why?')?.click();
    await waitFor(() => document.body.innerText.includes('Accepting changes'));
  }

  if (s.name === 'watch-rechecking') {
    // The accept request is hung (?hang=accept), so the panel stays in its
    // authoritative "Re-checking…" state with every control inert.
    await waitFor(() => Boolean(byName(/^Accept$/)));
    byName(/^Accept$/)?.click();
    await waitFor(() => document.body.innerText.includes('Re-checking'));
  }

  if (s.name === 'editor-panel-long' || s.name === 'thread-newest') {
    // The thread's own auto-scroll-to-newest effect has already run; give it the
    // frame it needs after the last message paints.
    await sleep(300);
  }

  if (s.name === 'thread-midway') {
    // Park the thread half way up, by SCROLLING the real panel body rather than
    // by feeding the component a special prop — the point of the state is that
    // the thread scrolls freely and does not snap back to the bottom.
    await sleep(300);
    const body = document.querySelector('[data-testid="sp-panel-body"]') as HTMLElement | null;
    if (body) {
      body.scrollTop = Math.floor((body.scrollHeight - body.clientHeight) / 2);
      await sleep(200);
    }
  }

  // The timeline's centre-today runs post-layout; wait for the grid to have a
  // settled scrollLeft rather than assuming one frame is enough.
  const grid = document.querySelector('[data-sp-grid], [data-testid="sp-grid-viewport"]') as HTMLElement | null;
  if (grid) {
    let last = -1;
    for (let i = 0; i < 30 && last !== grid.scrollLeft; i++) {
      last = grid.scrollLeft;
      await sleep(50);
    }
  }
  await sleep(150);
}

drive()
  .then(() => {
    window.__parityReady = true;
  })
  .catch((err: unknown) => {
    window.__parityError = err instanceof Error ? err.message : String(err);
    window.__parityReady = true;
  });
