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
    expect(table.getByText('3 / 404')).toBeInTheDocument();
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
    expect(activeContextLabels(packet)[0]!.title).toBe('Learning signal');
    expect(JSON.stringify(evidenceContextPacket(packet))).not.toContain('12345678');
    expect(JSON.stringify(evidenceContextPacket(packet))).not.toContain('source_unavailable');
    expect(meriCoverageReason(packet.degradedReason!)).toBe('Institutional Knowledge could not be read during initial context retrieval');
  });
});
