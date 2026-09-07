import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeriEvidenceTab } from './MeriEvidenceTab.js';
import { mapPersistedRetrieval } from './meri-route-state.js';
import { meriRetrievalMetadata } from '../../components/chat/meri-retrieval-metadata.js';
import {
  appendChatMessage,
  getChatStateSnapshot,
  resetChatStoreForTests,
  setChatMessageRetrieval,
} from '../../components/chat/chat-store.js';

vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));

const retrieval = {
  plan: {
    subjectScope: 'client',
    queryClass: 'lookup',
    targetHint: null,
    recipeTool: null,
    requiredDomains: ['strategies_work', 'hearings'],
    requireCompleteCoverage: true,
    timeWindow: { expression: 'last 30 days', withinDays: 30 },
  },
  coverage: {
    complete: false,
    stopReason: 'model_context_projection_truncated',
    requestedDomains: ['strategies_work', 'hearings'],
    searchedDomains: ['strategies_work'],
    missingDomains: ['hearings'],
    partialDomains: ['strategies_work'],
    requestedEntityCount: 2,
    searchedEntityCount: 1,
    recordsEvaluated: 26,
    recordsReturned: 10,
    paginationComplete: false,
    truncated: true,
    toolsInvoked: ['retrieval-v2:strategies_work'],
    sourceHealth: [
      {
        source: 'strategies_work',
        status: 'partial' as const,
        lastSyncAt: '2026-08-30T10:30:00.000Z',
        detail: 'pagination_incomplete',
      },
      { source: 'hearings', status: 'unavailable' as const, detail: 'source_disabled' },
    ],
    unavailableSources: [{ source: 'hearings', reason: 'source_disabled' }],
  },
};

describe('Meri public coverage contract', () => {
  beforeEach(resetChatStoreForTests);
  it('preserves the identical source coverage, counts and freshness on streaming and reload', () => {
    appendChatMessage({
      id: 'canonical',
      role: 'assistant',
      content: 'Brief',
      createdAt: new Date(),
    });
    setChatMessageRetrieval('canonical', retrieval);
    expect(getChatStateSnapshot().messages[0]?.retrieval).toEqual(retrieval);
    expect(mapPersistedRetrieval({ metadata: { retrieval } })).toEqual(retrieval);
  });

  it('shows precise partial/missing domains, counts, pagination and actual sync times', () => {
    render(
      <MeriEvidenceTab
        sources={[]}
        verifyStats={[]}
        claims={[]}
        groundingCaveat={null}
        retrieval={mapPersistedRetrieval({ metadata: { retrieval } })!}
      />,
    );
    expect(screen.getByText('REQUIRED SOURCE MISSING')).toBeInTheDocument();
    expect(screen.getByText('10 records returned · 26 records evaluated.')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 requested entities searched.')).toBeInTheDocument();
    expect(screen.getByText('Additional result pages were not fully read.')).toBeInTheDocument();
    expect(screen.getByText('Some records or text were shortened or omitted.')).toBeInTheDocument();
    const table = within(screen.getByRole('table', { name: 'Source coverage and freshness' }));
    expect(table.getByText('2026-08-30 10:30:00 UTC')).toBeInTheDocument();
    expect(table.getByText('Not reported')).toBeInTheDocument();
    expect(table.getByText('More result pages remain')).toBeInTheDocument();
    expect(screen.getByText(/timestamp alone does not establish/)).toBeInTheDocument();
  });

  it('shows recorded coverage even when there are no citations or warnings', () => {
    render(
      <MeriEvidenceTab
        sources={[]}
        verifyStats={[]}
        claims={[]}
        groundingCaveat={null}
        retrieval={{
          plan: retrieval.plan,
          coverage: {
            complete: true,
            stopReason: 'complete',
            recordsReturned: 0,
            recordsEvaluated: 0,
          },
        }}
      />,
    );
    expect(screen.getByRole('region', { name: 'Initial context coverage' })).toBeInTheDocument();
    expect(screen.getByText('0 records returned · 0 records evaluated.')).toBeInTheDocument();
    expect(screen.queryByText('No evidence was recorded for this turn.')).not.toBeInTheDocument();
  });

  it('drops malformed counts/dates/status and does not fill unknown freshness with today', () => {
    const normalized = meriRetrievalMetadata({
      ...retrieval,
      coverage: {
        ...retrieval.coverage,
        recordsReturned: -1,
        requestedEntityCount: null,
        recordsEvaluated: NaN,
        sourceHealth: [
          null,
          { source: 'hearings', status: 'complete', lastSyncAt: 'invalid' },
          { source: 'bills', status: 'invented' },
        ],
        unavailableSources: [{ source: 42 }],
      },
    });
    expect(normalized?.coverage.recordsReturned).toBeUndefined();
    expect(normalized?.coverage.recordsEvaluated).toBeUndefined();
    expect(normalized?.coverage.requestedEntityCount).toBeNull();
    expect(normalized?.coverage.sourceHealth).toEqual([{ source: 'hearings', status: 'complete' }]);
    expect(normalized?.coverage.unavailableSources).toEqual([]);
  });
});
