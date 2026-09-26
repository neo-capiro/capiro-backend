import { BadRequestException } from '@nestjs/common';
import { BuyerWorkspaceService } from './buyer-workspace.service.js';
import type { AcquisitionContinuityReadService } from '../acquisition-continuity/acquisition-continuity-read.service.js';
import type { FundingExecutionReadService } from '../funding-execution/funding-execution-read.service.js';
import type { FederalEvidenceReadService } from '../federal-evidence/federal-evidence-read.service.js';

const knownAt = '2026-09-24T00:00:00.000Z';
const input = { peCode: ' 0601234a ', asOfFy: 2026, knownAt };

function fixture() {
  const calls: unknown[] = [];
  const acquisition = { read: async (scope: unknown) => {
    calls.push(scope);
    return {
      asOfFy: 2026, knownAt, accepted: [], candidates: [{ status: 'candidate', authoritativeAmountUsd: null }],
      unresolved: [], coverage: { state: 'partial', sourceFreshness: [{ source: 'usaspending', state: 'stale' }], unresolvedReasons: [] },
    };
  } } as unknown as AcquisitionContinuityReadService;
  const funding = { read: async (scope: unknown) => {
    calls.push(scope);
    return {
      asOfFy: 2026, knownAt,
      proposed: { transactionDeltas: [{ amountUsd: '-12.00' }] },
      enacted: { cumulativeSnapshots: [{ amountUsd: '100.00' }] },
      coverage: { state: 'unsupported', sourceFreshness: [], unresolvedReasons: [{ code: 'source_unavailable' }] },
    };
  } } as unknown as FundingExecutionReadService;
  const evidence = {
    currentQualifiedMentions: async (_peCode: string, options: unknown) => {
      calls.push({ evidence: 'mentions', options });
      return { items: [{ sourceUrl: 'https://example.gov/text', qualificationState: 'qualified' }], hasMore: false, nextCursor: null };
    },
    lifecycleTimeline: async (_scope: unknown, options: unknown) => {
      calls.push({ evidence: 'lifecycle', options });
      return { items: [], hasMore: true, nextCursor: 'next' };
    },
  } as unknown as FederalEvidenceReadService;
  return { service: new BuyerWorkspaceService(acquisition, funding, evidence), calls };
}

describe('BuyerWorkspaceService', () => {
  it('shares one pinned scope and preserves section uncertainty and accounting categories', async () => {
    const { service, calls } = fixture();
    const result = await service.read(input);
    expect(calls).toEqual([
      { peCode: '0601234A', asOfFy: 2026, knownAt },
      { peCode: '0601234A', asOfFy: 2026, knownAt },
      { evidence: 'mentions', options: { knownAt, limit: 100, cursor: undefined } },
      { evidence: 'lifecycle', options: { knownAt, limit: 100, cursor: undefined } },
    ]);
    expect(result.acquisition.state).toBe('partial');
    expect(result.acquisition.data.candidates[0]!.authoritativeAmountUsd).toBeNull();
    expect(result.acquisition.freshness[0]!.state).toBe('stale');
    expect(result.fundingExecution.state).toBe('unsupported');
    expect(result.fundingExecution.data.proposed.transactionDeltas[0]!.amountUsd).toBe('-12.00');
    expect(result.fundingExecution.data.enacted.cumulativeSnapshots[0]!.amountUsd).toBe('100.00');
    expect(result.budget.state).toBe('unsupported');
    expect(result.federalEvidence.state).toBe('partial');
    expect(result.federalEvidence.data.mentions.items[0]!.qualificationState).toBe('qualified');
    expect(result.federalEvidence.data.lifecycle.nextCursor).toBe('next');
    expect(result.federalEvidence.data.lifecycle.hasMore).toBe(true);
  });

  it('passes independent federal evidence cursors and preserves each page boundary', async () => {
    const { service, calls } = fixture();
    const result = await service.read({
      ...input,
      mentionsCursor: 'mentions-page-2',
      lifecycleCursor: 'lifecycle-page-3',
    });
    expect(calls).toContainEqual({
      evidence: 'mentions', options: { knownAt, limit: 100, cursor: 'mentions-page-2' },
    });
    expect(calls).toContainEqual({
      evidence: 'lifecycle', options: { knownAt, limit: 100, cursor: 'lifecycle-page-3' },
    });
    expect(result.federalEvidence.data.mentions).toMatchObject({ hasMore: false, nextCursor: null });
    expect(result.federalEvidence.data.lifecycle).toMatchObject({ hasMore: true, nextCursor: 'next' });
    expect(result.federalEvidence.state).toBe('partial');
    expect(result.federalEvidence.coverage.unresolvedReasons[0]!.code).toBe('federal_evidence_page_incomplete');
  });

  it('rejects unpinned or invalid temporal scope', async () => {
    const { service } = fixture();
    await expect(service.read({ ...input, knownAt: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.read({ ...input, asOfFy: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails when a section returns a different temporal scope', async () => {
    const { service } = fixture();
    await expect(service.read({ ...input, knownAt: '2025-01-01T00:00:00Z' })).rejects.toThrow('temporal scope mismatch');
  });
});
