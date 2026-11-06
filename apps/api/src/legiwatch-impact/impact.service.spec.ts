import { NotFoundException } from '@nestjs/common';
import type { TenantContext, LegiWatchImpactAnalysis } from '@capiro/shared';
import { ImpactService, currentImpact } from './impact.service.js';
import { emptyImpact } from './impact.repository.js';
import type { ImpactEvidenceSnapshot } from './impact-evidence.types.js';

const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-actor' } as TenantContext;
const snapshot: ImpactEvidenceSnapshot = {
  clientId: 'client',
  billId: '119-hr-1',
  fingerprint: 'current',
  billStatus: 'introduced',
  versions: [],
  provisions: [],
  clientFacts: [],
  coverageNotes: [],
};
const result: LegiWatchImpactAnalysis = {
  ...emptyImpact(),
  status: 'ready',
  summary: 'Cited client impact',
  inputFingerprint: 'current',
  analyzedAt: '2026-11-06T00:00:00Z',
};
function fixture() {
  const tx = {};
  const prisma = { withTenantUser: jest.fn(async (_tenant, _user, fn) => fn(tx)) };
  const repository = {
    row: jest.fn().mockResolvedValue({
      clientId: 'client',
      billId: '119-hr-1',
      trackerBackend: 'core',
      sourceUrl: null,
      analysis: null,
    }),
    save: jest.fn().mockResolvedValue(result),
    actions: jest.fn().mockResolvedValue([]),
    refresh: jest.fn().mockResolvedValue(null),
  };
  const evidence = { load: jest.fn().mockResolvedValue(snapshot) };
  const analysis = { analyze: jest.fn().mockResolvedValue(result) };
  return {
    prisma,
    repository,
    evidence,
    analysis,
    service: new ImpactService(
      prisma as never,
      repository as never,
      evidence as never,
      analysis as never,
    ),
  };
}

it('suppresses saved prose and citations after evidence changes or source revocation', () => {
  const old = {
    ...result,
    inputFingerprint: 'old',
    findings: [{ mechanism: 'Restricted old text' } as never],
  };
  const current = currentImpact(old, snapshot);
  expect(current).toMatchObject({
    stale: true,
    status: 'needs_evidence',
    findings: [],
    inputFingerprint: null,
  });
  expect(JSON.stringify(current)).not.toContain('Restricted old text');
  expect(current.summary).not.toContain('Cited client impact');
});
it('revalidates evidence after inference and refuses to save against a changed profile', async () => {
  const f = fixture();
  f.evidence.load
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, fingerprint: 'new' });
  await expect(f.service.analyze(ctx, 'client', '119-hr-1')).rejects.toThrow('evidence changed');
  expect(f.repository.save).not.toHaveBeenCalled();
});
it('fails closed if a grant is revoked or tracked bill removed during inference', async () => {
  const f = fixture();
  f.repository.row
    .mockResolvedValueOnce({ trackerBackend: 'core', analysis: null })
    .mockRejectedValueOnce(new NotFoundException('Client not found'));
  await expect(f.service.analyze(ctx, 'client', '119-hr-1')).rejects.toThrow('Client not found');
  expect(f.repository.save).not.toHaveBeenCalled();
});
it('skips model spend for a current completed analysis and returns persisted evidence', async () => {
  const f = fixture();
  f.repository.row.mockResolvedValue({
    clientId: 'client',
    billId: '119-hr-1',
    trackerBackend: 'core',
    sourceUrl: null,
    analysis: result,
  });
  expect((await f.service.analyze(ctx, 'client', '119-hr-1')).row.impact).toMatchObject({
    summary: 'Cited client impact',
    stale: false,
  });
  expect(f.analysis.analyze).not.toHaveBeenCalled();
});
it('persists a verified result only after current actor scope and inputs are read again', async () => {
  const f = fixture();
  const detail = await f.service.analyze(ctx, 'client', '119-hr-1');
  expect(f.repository.row).toHaveBeenCalledTimes(2);
  expect(f.repository.save).toHaveBeenCalledWith(
    expect.anything(),
    ctx,
    'client',
    '119-hr-1',
    result,
  );
  expect(detail.row.impact.summary).toBe(result.summary);
});

it('preserves a concurrent successful result when a slower attempt fails', async () => {
  const f = fixture();
  f.repository.row
    .mockResolvedValueOnce({
      clientId: 'client',
      billId: '119-hr-1',
      trackerBackend: 'core',
      sourceUrl: null,
      analysis: null,
    })
    .mockResolvedValueOnce({
      clientId: 'client',
      billId: '119-hr-1',
      trackerBackend: 'core',
      sourceUrl: null,
      analysis: result,
    });
  f.analysis.analyze.mockResolvedValue({ ...emptyImpact(), status: 'unavailable' });
  const guard = jest.fn().mockResolvedValue(undefined);
  const detail = await f.service.analyze(ctx, 'client', '119-hr-1', guard);
  expect(guard).toHaveBeenCalled();
  expect(f.repository.save).not.toHaveBeenCalled();
  expect(detail.row.impact.summary).toBe(result.summary);
});
