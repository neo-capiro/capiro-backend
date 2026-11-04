import { parseManualFieldEvidence, manualCodeEvidence } from './profile-manual-field-evidence.js';

const citation = {
  label: 'Company website',
  url: 'https://fixture.example/about',
  excerpt: 'Engineering design services',
  source: 'website',
  observedAt: '2026-11-04T12:00:00Z',
};
describe('explicitly accepted manual suggestion evidence', () => {
  it('retains citations as person-reviewed evidence on the same submitted code', () => {
    const input = parseManualFieldEvidence(
      { naicsCodes: [{ code: '541330', evidence: [citation] }] },
      { naicsCodes: ['541330'] },
    );
    expect(manualCodeEvidence(input, 'naicsCodes')).toEqual([
      { ...citation, code: '541330', sourceType: 'person_reviewed_suggestion' },
    ]);
  });
  it.each([
    [{ naicsCodes: [{ code: '541330', evidence: [citation] }] }, {}],
    [{ naicsCodes: [{ code: '541330', evidence: [citation] }] }, { naicsCodes: ['111110'] }],
    [
      { uei: [{ code: 'ABCDE1234567', evidence: [{ ...citation, officialProof: true }] }] },
      { uei: 'ABCDE1234567' },
    ],
    [{ name: [{ code: 'Fixture', evidence: [citation] }] }, { name: 'Fixture' }],
    [
      { pscCodes: [{ code: 'R425', evidence: [{ ...citation, url: 'javascript:alert(1)' }] }] },
      { pscCodes: ['R425'] },
    ],
  ])('rejects mismatched codes, unsupported fields and caller-supplied proof', (raw, fields) => {
    expect(() => parseManualFieldEvidence(raw, fields)).toThrow();
  });
  it('keeps attachment IDs at the visible evidence root for current ACL checks and redaction', () => {
    const attachmentId = '10000000-0000-4000-8000-000000000001';
    const parsed = parseManualFieldEvidence(
      {
        cageCode: [
          { code: 'abc12', evidence: [{ label: 'Brochure', attachmentId, excerpt: 'CAGE ABC12' }] },
        ],
      },
      { cageCode: 'ABC12' },
    );
    expect(manualCodeEvidence(parsed, 'cageCode')[0]).toMatchObject({
      attachmentId,
      code: 'ABC12',
      sourceType: 'person_reviewed_suggestion',
    });
  });
});
