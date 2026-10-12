import {
  buildEffectiveDateEvidence,
  dateOnly,
  readEffectiveDateEvidence,
} from './effective-date-evidence.js';

const source = {
  document_number: '2026-12345',
  type: 'Rule',
  publication_date: '2026-10-12',
  effective_on: '2026-11-12',
  pdf_url: 'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
  correction_of: null,
  corrections: [],
};
const time = new Date('2026-10-12T06:00:00.000Z');

describe('publisher effective-date evidence', () => {
  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-11-12T12:00:00Z',
    '11/12/2026',
    ' 2026-11-12',
    null,
    42,
  ])('rejects non-date-only effective source %p', (value) => expect(dateOnly(value)).toBeNull());
  it('retains date-only precision, field identity and publisher/official edition provenance', () => {
    const receipt = buildEffectiveDateEvidence(source, time);
    expect(receipt).toMatchObject({
      dateKind: 'effective',
      date: '2026-11-12',
      revision: 1,
      status: 'supported',
      sourceField: 'effective_on',
      authority: 'federal_register_publisher_metadata',
    });
    expect(readEffectiveDateEvidence(receipt, source.document_number)).toEqual(receipt);
  });
  it('never substitutes publication or comment dates when effective_on is absent', () => {
    const receipt = buildEffectiveDateEvidence(
      {
        ...source,
        effective_on: null,
        publication_date: '2026-11-12',
        comments_close_on: '2026-11-12',
      } as typeof source,
      time,
    );
    expect(receipt).toMatchObject({ date: null, status: 'missing_date' });
  });
  it.each([
    'https://govinfo.gov.evil.example/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
    'http://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
    'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-54321.pdf',
    'https://name:pass@www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf',
    'https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/2026-12345.pdf?redirect=evil',
    null,
  ])('fails closed on unofficial/mismatched PDF %p', (pdf) => {
    expect(buildEffectiveDateEvidence({ ...source, pdf_url: pdf }, time).status).toBe(
      'missing_official_pdf',
    );
  });
  it('refuses unsupported document kinds even with a date', () => {
    expect(buildEffectiveDateEvidence({ ...source, type: 'Proposed Rule' }, time).status).toBe(
      'unsupported_document_type',
    );
  });
  it.each([
    {},
    { correction_of: null },
    { correction_of: null, corrections: ['https://evil.example'] },
    { correction_of: 42, corrections: [] },
  ])('requires complete canonical correction metadata %p', (meta) => {
    const { correction_of: _a, corrections: _b, ...base } = source;
    expect(buildEffectiveDateEvidence({ ...base, ...meta }, time).status).toBe(
      'incomplete_correction_metadata',
    );
  });
  it('does not resolve separately published corrections into a fabricated revised effective date', () => {
    const receipt = buildEffectiveDateEvidence(
      {
        ...source,
        corrections: ['https://www.federalregister.gov/api/v1/documents/2026-54321.json'],
      },
      time,
    );
    expect(receipt.status).toBe('correction_requires_review');
  });
  it('refreshes observation without revision churn and tracks latest actual correction', () => {
    const first = buildEffectiveDateEvidence(source, time);
    const repeated = buildEffectiveDateEvidence(source, new Date(time.getTime() + 1000), first);
    expect(repeated.revision).toBe(1);
    expect(repeated.changedAt).toBe(first.changedAt);
    const corrected = buildEffectiveDateEvidence(
      { ...source, effective_on: '2026-12-01' },
      new Date(time.getTime() + 2000),
      repeated,
    );
    expect(corrected).toMatchObject({
      revision: 2,
      date: '2026-12-01',
      previous: { date: '2026-11-12', revision: 1 },
    });
    const withdrawn = buildEffectiveDateEvidence(
      { ...source, effective_on: null },
      new Date(time.getTime() + 3000),
      corrected,
    );
    expect(withdrawn).toMatchObject({
      revision: 3,
      date: null,
      status: 'missing_date',
      previous: { date: '2026-12-01' },
    });
  });
  it('rejects tampered projection, foreign receipt and unsupported legacy JSON', () => {
    const receipt = buildEffectiveDateEvidence(source, time);
    expect(
      readEffectiveDateEvidence({ ...receipt, date: '2026-12-01' }, source.document_number),
    ).toBeNull();
    expect(readEffectiveDateEvidence(receipt, '2026-54321')).toBeNull();
    expect(readEffectiveDateEvidence({ date: '2026-11-12' }, source.document_number)).toBeNull();
  });
});
