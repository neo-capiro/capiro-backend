import { persistFederalRegisterObservation } from './federal-register-observation.js';
import { buildEffectiveDateEvidence } from './effective-date-evidence.js';
const source = {
  document_number: '2026-12345',
  type: 'Rule',
  publication_date: '2026-10-12',
  effective_on: '2026-11-12',
  pdf_url: 'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
  correction_of: null,
  corrections: [],
};
const metadata = {
  documentNumber: source.document_number,
  type: 'RULE',
  title: 'Rule',
  agencyNames: [],
  publicationDate: new Date('2026-10-12'),
  pdfUrl: source.pdf_url,
  docketIds: [],
  cfrReferences: [],
  topics: [],
};
const observedAt = new Date('2026-10-12T06:00:00Z');
function harness(prior: unknown = null, priorTime: Date | null = null) {
  const trace: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('advisory')) {
        trace.push('identity_lock');
        return [];
      }
      trace.push('row_lock');
      return priorTime ? [{ evidence: prior, observedAt: priorTime }] : [];
    }),
    federalRegisterDocument: {
      upsert: jest.fn(async (_args: any) => {
        trace.push('metadata');
        return {};
      }),
    },
    $executeRaw: jest.fn(async () => {
      trace.push('evidence');
      return 1;
    }),
  };
  const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { trace, tx, prisma };
}
describe('Federal Register atomic evidence ingestion', () => {
  it('locks canonical identity before row/read and commits exact date metadata with evidence', async () => {
    const h = harness();
    await expect(
      persistFederalRegisterObservation(h.prisma as any, source, observedAt, metadata),
    ).resolves.toBe('updated');
    expect(h.trace).toEqual(['identity_lock', 'row_lock', 'metadata', 'evidence']);
    expect(h.tx.federalRegisterDocument.upsert.mock.calls[0]![0]).toMatchObject({
      create: { effectiveDate: new Date('2026-11-12T00:00:00Z') },
      update: { effectiveDate: new Date('2026-11-12T00:00:00Z') },
    });
  });
  it.each([-1000, 0])(
    'older/equal response (%i ms) cannot roll back corrected metadata or evidence',
    async (delta) => {
      const prior = buildEffectiveDateEvidence(
        { ...source, effective_on: '2026-12-01' },
        observedAt,
      );
      const h = harness(prior, observedAt);
      expect(
        await persistFederalRegisterObservation(
          h.prisma as any,
          source,
          new Date(observedAt.getTime() + delta),
          metadata,
        ),
      ).toBe('stale');
      expect(h.trace).toEqual(['identity_lock', 'row_lock']);
    },
  );
  it('missing corrected effective_on clears old date atomically', async () => {
    const prior = buildEffectiveDateEvidence(source, new Date(observedAt.getTime() - 1000));
    const h = harness(prior, new Date(observedAt.getTime() - 1000));
    await persistFederalRegisterObservation(
      h.prisma as any,
      { ...source, effective_on: null },
      observedAt,
      metadata,
    );
    expect(h.tx.federalRegisterDocument.upsert.mock.calls[0]![0]).toMatchObject({
      update: { effectiveDate: null },
    });
  });
  it('evidence failure rejects whole transaction instead of acknowledging metadata-only success', async () => {
    const h = harness();
    h.tx.$executeRaw.mockRejectedValueOnce(new Error('db failure'));
    await expect(
      persistFederalRegisterObservation(h.prisma as any, source, observedAt, metadata),
    ).rejects.toThrow('db failure');
  });
});
