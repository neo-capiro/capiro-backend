/**
 * Regression test for a bug that took down the entire Strategies module on
 * os.capiro.ai: `VNextStrategiesRoutes` renders its own `<Routes>` with
 * relative paths (`index`, `":strategyId"`, ...), but `VNextRouter` mounts it
 * as a plain component off a `location.pathname` check — the same pattern
 * every other vNext module uses (see client-crm-entry.test.tsx for the sibling
 * bug in that module) — never through a matched `<Route>` + `<Outlet>` chain.
 * With no ancestor route to strip a `/strategies` prefix, the relative
 * `<Routes>` matched against the FULL browser pathname: a bare `/strategies`
 * (one path segment) matched the dynamic `":strategyId"` route instead of
 * `index`, with `strategyId` literally set to the string "strategies" — which
 * then failed the UUID guard in StrategyEditorVNext and rendered "This
 * strategy link is not valid" for every single visit to the library. No
 * existing test caught this because none of them mounted the routes the way
 * `VNextRouter` actually does (bare, no wrapping `<Route>`).
 *
 * This locks in the fix: every route inside `VNextStrategiesRoutes` uses an
 * absolute `/strategies...` path, and this test mounts it exactly like
 * `VNextRouter` does — no ancestor `<Route>` — so a regression back to
 * relative paths fails immediately.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { VNextStrategiesRoutes } from './VNextStrategiesRoutes.js';

vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({
    isLoading: false,
    data: { features: { strategyPlanner: true, agenticMeri: false } },
  }),
}));

vi.mock('./StrategyLibraryVNext.js', () => ({
  StrategyLibraryVNext: () => <div data-testid="library-stub">library</div>,
}));

function EditorStub() {
  const { strategyId } = useParams<{ strategyId: string }>();
  return <div data-testid="editor-stub">{strategyId}</div>;
}

vi.mock('./StrategyEditorVNext.js', () => ({
  StrategyEditorVNext: () => <EditorStub />,
}));

const REAL_UUID = '6481f205-900c-4d59-8089-ec117f354c6b';

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      {/* No wrapping <Route> — this is the exact composition VNextRouter uses. */}
      <MemoryRouter initialEntries={[path]}>
        <VNextStrategiesRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextStrategiesRoutes — mounted the way VNextRouter actually mounts it', () => {
  it('renders the library at bare /strategies, not the editor', () => {
    renderAt('/strategies');
    expect(screen.getByTestId('library-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-stub')).not.toBeInTheDocument();
  });

  it('never resolves strategyId to the literal string "strategies"', () => {
    renderAt('/strategies');
    expect(screen.queryByText('strategies')).not.toBeInTheDocument();
  });

  it('renders the editor with the real id at /strategies/:strategyId', () => {
    renderAt(`/strategies/${REAL_UUID}`);
    expect(screen.getByTestId('editor-stub')).toHaveTextContent(REAL_UUID);
    expect(screen.queryByTestId('library-stub')).not.toBeInTheDocument();
  });
});
