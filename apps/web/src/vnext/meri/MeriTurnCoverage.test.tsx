import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MeriCoverageWarning } from './MeriCoverageWarning.js';
import { MeriRetrievalCoverage } from './MeriRetrievalCoverage.js';
import { meriRetrievalMetadata, meriCoverageReason } from '../../components/chat/meri-retrieval-metadata.js';
import { activeContextLabels, evidenceContextPacket } from './meri-context-packet.js';
import type { MeriContextPacket } from './meri-vnext-api.js';

vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));
afterEach(cleanup);

const raw = {
  plan: { subjectScope: 'client', requiredDomains: ['institutional_knowledge'], queryClass: 'lookup' },
  coverage: { phase: 'turn', complete: false, stopReason: 'turn_coverage_partial',
    missingDomains: [], partialDomains: ['institutional_knowledge'], searchedDomains: ['institutional_knowledge'],
    recordsReturned: 0, recordsEvaluated: 0,
    restoredSources: ['institutional_knowledge'], unavailableSources: [],
    initialContext: { complete: false, stopReason: 'source_unavailable_or_unsupported',
      sourceHealth: [{ source: 'institutional_knowledge', status: 'error', detail: 'source_unavailable:institutional_knowledge' }] },
    toolReads: [{ tool: 'search_memory', source: 'institutional_knowledge', status: 'partial',
      recordsReturned: 3, recordsEvaluated: 404, paginationComplete: false, truncated: false,
      lastSyncAt: '2026-09-06T10:00:00.000Z', detail: 'pagination_incomplete' }],
  },
};

describe('turn coverage presentation', () => {
  it('renders recovered access and a remaining completeness warning together, with distinct phases and counts', () => {
    const retrieval = meriRetrievalMetadata(raw)!;
    render(<><MeriCoverageWarning retrieval={retrieval} /><MeriRetrievalCoverage retrieval={retrieval} /></>);
    expect(screen.queryByText('REQUIRED SOURCE MISSING')).not.toBeInTheDocument();
    expect(screen.getByText('PARTIAL COVERAGE')).toBeInTheDocument();
    expect(screen.getByText(/Later reads reached Institutional Knowledge/)).toBeInTheDocument();
    expect(screen.getByText('Initial context before later reads')).toBeInTheDocument();
    const table = within(screen.getByRole('table', { name: 'Subsequent tool reads' }));
    expect(table.getByText('Returned: 3')).toBeInTheDocument();
    expect(table.getByText('Inspected: 404')).toBeInTheDocument();
    expect(table.getByText('2026-09-06 10:00:00 UTC')).toBeInTheDocument();
    expect(table.getByText(/More pages remain/)).toBeInTheDocument();
    expect(screen.queryByText(/source_unavailable:/)).not.toBeInTheDocument();
    // Reload normalization keeps the same receipts instead of reverting to the initial packet.
    expect(meriRetrievalMetadata(JSON.parse(JSON.stringify(retrieval)))).toEqual(retrieval);
  });

  it('explains an unresolved initial client-profile gap alongside a successful document read', () => {
    const retrieval = meriRetrievalMetadata({ ...raw,
      plan: { ...raw.plan, requiredDomains: ['clients'] },
      coverage: { ...raw.coverage, restoredSources: [], missingDomains: ['clients'], partialDomains: [],
        toolReads: [{ ...raw.coverage.toolReads[0], source: 'client_documents', status: 'complete', paginationComplete: true }] },
    })!;
    render(<><MeriCoverageWarning retrieval={retrieval} /><MeriRetrievalCoverage retrieval={retrieval} /></>);
    expect(screen.getByText('INITIAL CONTEXT GAP REMAINS')).toBeInTheDocument();
    expect(screen.getByText('Initial context still missing: Client profile and work.')).toBeInTheDocument();
    expect(screen.getByText('Client documents')).toBeInTheDocument();
    expect(screen.getByText('Retrieved for this read')).toBeInTheDocument();
  });

  it('keeps unknown receipt counts/freshness unknown instead of inventing zero or today', () => {
    const retrieval = meriRetrievalMetadata({ ...raw, coverage: { ...raw.coverage,
      toolReads: [{ ...raw.coverage.toolReads[0], recordsReturned: -1, recordsEvaluated: '404', lastSyncAt: 'invalid' }, null],
    } })!;
    expect(retrieval.coverage.toolReads).toEqual([expect.objectContaining({ recordsReturned: null, recordsEvaluated: null })]);
    expect(retrieval.coverage.toolReads![0]).not.toHaveProperty('lastSyncAt');
  });

  it('translates context diagnostic codes and strips learning signal IDs from both context views', () => {
    const packet = { packetId: null, items: [{ id: 'signal', label: 'learning_signal:12345678-1234-1234-1234-123456789abc', type: 'learning_signal', scope: 'client', authority: 'unverified', rationale: null, selection: 'automatic' }],
      exclusions: [{ label: 'source_unavailable:institutional_knowledge', type: 'source', reason: 'source_error:institutional_knowledge' }],
      degraded: true, degradedReason: 'source_unavailable:institutional_knowledge',
    } as MeriContextPacket;
    expect(activeContextLabels(packet)[0]!.title).toBe('Learning signal · item 1 · CLIENT');
    expect(JSON.stringify(evidenceContextPacket(packet))).not.toContain('12345678');
    expect(JSON.stringify(evidenceContextPacket(packet))).not.toContain('source_unavailable');
    expect(meriCoverageReason(packet.degradedReason!)).toBe('Institutional Knowledge could not be read during initial context retrieval');
  });
});


describe('task-relevant coverage and source counts', () => {
  it('keeps a generic question free of unrelated required-source warnings', () => {
    const retrieval = meriRetrievalMetadata({ plan: { subjectScope: 'general', queryClass: 'lookup', requiredDomains: [], requireCompleteCoverage: false },
      coverage: { complete: false, missingDomains: ['clients', 'contacts'], searchedDomains: ['contacts'], stopReason: 'source_unavailable_or_unsupported' } })!;
    render(<MeriCoverageWarning retrieval={retrieval} />);
    expect(screen.queryByText('REQUIRED SOURCE MISSING')).not.toBeInTheDocument();
    expect(screen.getByText('CONTEXT LIMITATIONS')).toBeInTheDocument();
    expect(screen.getByText('Could not read: Contacts.')).toBeInTheDocument();
  });

  it('persists and displays unequal source counts without using total matches as inspected', () => {
    const counts = { source: 'clients', recordsMatched: 30, recordsEvaluated: 19,
      recordsReturned: 7, recordsDisplayed: 3, recordsOmitted: 4 };
    const input = { ...raw, coverage: { ...raw.coverage, recordsReturned: 7, recordsEvaluated: 19,
      recordsDisplayed: 3, recordsOmitted: 4, sourceCounts: [counts],
      toolReads: [{ ...raw.coverage.toolReads[0], ...counts, recordsEvaluated: null }] } };
    const retrieval = meriRetrievalMetadata(input)!;
    expect(meriRetrievalMetadata(JSON.parse(JSON.stringify(retrieval)))).toEqual(retrieval);
    render(<MeriRetrievalCoverage retrieval={retrieval} />);
    const initial = within(screen.getByRole('table', { name: 'Initial source record counts' }));
    for (const label of ['Matched: 30', 'Inspected: 19', 'Returned: 7', 'Displayed: 3', 'Omitted: 4']) expect(initial.getByText(label)).toBeInTheDocument();
    const later = within(screen.getByRole('table', { name: 'Subsequent tool reads' }));
    expect(later.getByText('Inspected: Unknown')).toBeInTheDocument();
  });

  it('keeps metadata-only context items distinct without fabricating their contents', () => {
    const packet = { items: Array.from({ length: 3 }, (_, index) => ({ id: `signal-${index}`,
      label: `learning_signal:12345678-1234-1234-1234-123456789ab${index}`,
      type: 'learning_signal', scope: 'client', authority: 'unknown', selection: 'automatic',
      asOf: '2026-09-09T10:00:00.000Z' })), exclusions: [], packetId: 'packet' } as unknown as MeriContextPacket;
    const titles = activeContextLabels(packet).map((item) => item.title);
    expect(new Set(titles).size).toBe(3);
    expect(titles[0]).toBe('Learning signal · item 1 · CLIENT · 2026-09-09');
    expect(evidenceContextPacket(packet).included.map((item) => item.name)).toEqual(titles);
    expect(JSON.stringify(titles)).not.toContain('12345678');
  });
});
