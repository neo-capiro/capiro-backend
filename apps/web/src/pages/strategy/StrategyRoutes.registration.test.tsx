/*
 * Phase 1 §4.7 — removing the landing buttons must NOT retire their routes.
 *
 * Deep links, the node execution flow and the firm-level review surface all
 * still depend on /strategies/context*, /strategies/agents/review and
 * /strategies/agents/execution. Each is asserted to still resolve.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

vi.mock('../../lib/me.js', () => ({
  useMe: () => ({
    ...idle,
    data: { features: { strategyPlanner: true, agenticMeri: true } },
  }),
}));

// Every routed surface is stubbed to a marker: this test is about ROUTING, not
// about what each page renders.
vi.mock('./StrategyLibraryPage.js', () => ({ StrategyLibraryPage: () => <div>MARK library</div> }));
vi.mock('./StrategyEditorPage.js', () => ({ StrategyEditorPage: () => <div>MARK editor</div> }));
vi.mock('./context/ContextLibrary.js', () => ({ ContextLibrary: () => <div>MARK context</div> }));
vi.mock('./context/ContextDocumentView.js', () => ({
  ContextDocumentView: () => <div>MARK document</div>,
}));
vi.mock('./context/StewardReview.js', () => ({ StewardReview: () => <div>MARK steward</div> }));
vi.mock('./agents/ReviewQueue.js', () => ({ ReviewQueue: () => <div>MARK review</div> }));
vi.mock('./agents/ExecutionReview.js', () => ({ ExecutionReview: () => <div>MARK execution</div> }));

import { StrategyRoutes } from './StrategyRoutes.js';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/strategies/*" element={<StrategyRoutes />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StrategyRoutes registration', () => {
  test.each([
    ['/strategies', 'MARK library'],
    ['/strategies/context', 'MARK context'],
    ['/strategies/context/steward', 'MARK steward'],
    ['/strategies/context/3f2b6c1e-9a44-4f0b-8c21-7d9e5a1b2c3d', 'MARK document'],
    ['/strategies/agents/review', 'MARK review'],
    ['/strategies/agents/execution', 'MARK execution'],
    ['/strategies/3f2b6c1e-9a44-4f0b-8c21-7d9e5a1b2c3d', 'MARK editor'],
  ])('%s still resolves', (path, marker) => {
    const { unmount } = renderAt(path);
    expect(screen.getByText(marker)).toBeInTheDocument();
    unmount();
  });

  test('the static agent paths win over the free :id segment', () => {
    const { unmount } = renderAt('/strategies/agents/review');
    expect(screen.queryByText('MARK editor')).toBeNull();
    unmount();
  });
});
