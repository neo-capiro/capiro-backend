import { syncCollection } from './sync-federal-legislative-evidence.js';
import {
  persistFederalEvidenceSnapshot,
  persistFederalEvidenceRemoval,
} from '../src/program-element/federal-evidence/persistence.js';

jest.mock('../src/program-element/federal-evidence/persistence.js', () => ({
  persistFederalEvidenceSnapshot: jest.fn(async () => ({
    revisionInserted: true,
    pendingUnknownCodes: [],
  })),
  persistFederalEvidenceRemoval: jest.fn(),
  replayPendingFederalEvidenceMentions: jest.fn(),
}));

function fixture(packages: Array<{ packageId: string; congress?: number; dateIssued?: string }>) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const prisma: any = {
    $queryRawUnsafe: jest.fn(async () => [{ id: '119-hr-1' }]),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      if (parts.join('?').includes('INSERT INTO federal_evidence_checkpoint'))
        return [{ cursor: null, status: 'pending', completedAt: null }];
      throw Error('Unexpected unscoped reconciliation read');
    }),
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      writes.push({ sql: parts.join('?'), values });
      return 1;
    }),
  };
  const gov: any = {
    listFederalEvidencePage: jest.fn(async () => ({ packages, nextPage: null })),
    getFederalPackageText: jest.fn(async () => ({
      sourceUrl: 'https://www.govinfo.gov/fixture',
      raw: 'immutable bytes',
      originalBytes: { base64: Buffer.from('immutable bytes').toString('base64'), sha256: 'a'.repeat(64), mime: 'text/plain' },
      text: 'Complete text of this version.',
      dateIssued: '2025-02-01',
      format: 'text',
      collection: 'BILLS',
    })),
  };
  const run = (cap = 100) =>
    syncCollection({
      prisma,
      gov,
      collection: 'BILLS',
      congress: 119,
      full: true,
      historical: true,
      cap,
      fy26: 2026,
    });
  return { prisma, gov, writes, run };
}

beforeEach(() => jest.clearAllMocks());
it('preserves every admitted parent version, even published before FY26, without retiring older evidence', async () => {
  const h = fixture([
    { packageId: 'BILLS-119hr1ih', congress: 119, dateIssued: '2025-02-01' },
    { packageId: 'BILLS-119hr1rh', congress: 119, dateIssued: '2026-03-01' },
    { packageId: 'BILLS-119hr2ih', congress: 119 },
  ]);
  const counts = await h.run();
  expect(counts).toMatchObject({ inserted: 2, skipped: 1, complete: true, errors: 0 });
  expect(h.gov.getFederalPackageText.mock.calls.map((a: string[]) => a[0])).toEqual([
    'BILLS-119hr1ih',
    'BILLS-119hr1rh',
  ]);
  expect(persistFederalEvidenceSnapshot).toHaveBeenCalledWith(
    h.prisma,
    expect.objectContaining({
      billId: '119-hr-1',
      rawContent: 'immutable bytes',
      originalBytes: expect.objectContaining({ sha256: 'a'.repeat(64) }),
      observationKey: expect.stringMatching(/:a{64}$/),
      versionCode: 'ih',
      historical: true,
    }),
  );
  expect(h.gov.getFederalPackageText).toHaveBeenCalledWith('BILLS-119hr1ih', { retainOriginalBytes: true });
  expect(persistFederalEvidenceRemoval).not.toHaveBeenCalled();
  expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  expect(h.prisma.$queryRaw.mock.calls[0][1]).toBe('govinfo-federal:full:BILLS:119:fy26');
});
it('counts excluded packages toward the cap and checkpoints the next inspection position', async () => {
  const h = fixture([
    { packageId: 'BILLS-119hr2ih', congress: 119 },
    { packageId: 'BILLS-119hr1ih', congress: 119 },
  ]);
  expect(await h.run(1)).toMatchObject({ inserted: 0, skipped: 1, complete: false });
  expect(h.gov.getFederalPackageText).not.toHaveBeenCalled();
  const checkpoint = h.writes.find((w) => w.sql.includes('SET cursor_jsonb'))!;
  expect(JSON.parse(String(checkpoint.values[0]))).toMatchObject({ offset: 1, full: true });
});
it('retains the failed version position for retry and releases the lease', async () => {
  const h = fixture([{ packageId: 'BILLS-119hr1ih', congress: 119 }]);
  h.gov.getFederalPackageText.mockRejectedValueOnce(Error('provider unavailable'));
  expect(await h.run()).toMatchObject({ inserted: 0, errors: 1, complete: false });
  const failure = h.writes.find((w) => w.sql.includes("status = 'failed'"))!;
  expect(JSON.parse(String(failure.values[0]))).toMatchObject({ offset: 0, full: true });
  expect(h.writes.at(-1)?.sql).toContain('SET lease_token = NULL, lease_until = NULL');
});

it('refuses a FY26 run that did not acquire its checkpoint lease', async () => {
  const h = fixture([{ packageId: 'BILLS-119hr1ih', congress: 119 }]);
  h.prisma.$queryRaw.mockResolvedValueOnce([]);
  await expect(h.run()).rejects.toThrow('FY26_FEDERAL_TEXT_LEASE_NOT_ACQUIRED');
  expect(h.gov.listFederalEvidencePage).not.toHaveBeenCalled();
  expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
});

it('preserves the deployed capture default and observation namespace for unscoped ingestion', async () => {
  const h = fixture([{ packageId: 'BILLS-119hr1ih', congress: 119 }]);
  const capture = { version: 'federal-source-capture/1' };
  h.gov.getFederalPackageText.mockResolvedValueOnce({
    sourceUrl: 'https://www.govinfo.gov/fixture', raw: 'Synthetic', text: 'Synthetic',
    format: 'txt', collection: 'BILLS', capture,
  });
  const counts = await syncCollection({ prisma: h.prisma, gov: h.gov, collection: 'BILLS',
    congress: 119, full: false, historical: false, cap: 1, fy26: null });
  expect(counts).toMatchObject({ inserted: 1, errors: 0, complete: true });
  expect(h.gov.getFederalPackageText).toHaveBeenCalledWith('BILLS-119hr1ih');
  expect(h.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  expect(persistFederalEvidenceSnapshot).toHaveBeenCalledWith(h.prisma, expect.objectContaining({
    capture, originalBytes: undefined,
    observationKey: expect.stringMatching(/:federal-source-capture\/1$/),
  }));
});
