import { normalizeProspectDocumentFacts } from './profile-document-extraction.js';
const text = 'Acme has UEI ABCDEFGHIJKL. Morgan Lee is President. Award announced 2026-01-02.';
const base = {
  section: 'registration',
  field: 'uei',
  text: 'ABCDEFGHIJKL',
  values: [],
  name: null,
  title: null,
  email: null,
  phone: null,
  publishedAt: null,
  url: null,
  quote: 'Acme has UEI ABCDEFGHIJKL.',
};
test('retains supported registration and refuses invented source quotes', () => {
  expect(normalizeProspectDocumentFacts({ facts: [base] }, text)[0]).toMatchObject({
    targetKey: 'uei',
    proposedValue: 'ABCDEFGHIJKL',
  });
  expect(() =>
    normalizeProspectDocumentFacts({ facts: [{ ...base, quote: 'Invented' }] }, text),
  ).toThrow('supporting source quote');
});
test('refuses malformed identifiers and preserves absent news dates as unknown', () => {
  expect(() =>
    normalizeProspectDocumentFacts({ facts: [{ ...base, text: 'WRONG' }] }, text),
  ).toThrow('registration identifier');
  expect(
    normalizeProspectDocumentFacts(
      {
        facts: [
          {
            ...base,
            section: 'news',
            field: null,
            text: 'Award announced',
            publishedAt: '2025-01-02',
            url: 'https://invented.example',
          },
        ],
      },
      text,
    )[0]?.proposedValue,
  ).toMatchObject({ publishedAt: null, url: null });
});
test('creates a leadership proposal, never a canonical record', () => {
  expect(
    normalizeProspectDocumentFacts(
      {
        facts: [
          {
            ...base,
            section: 'leadership',
            field: null,
            name: 'Morgan Lee',
            title: 'President',
            quote: 'Morgan Lee is President.',
          },
        ],
      },
      text,
    )[0],
  ).toMatchObject({ kind: 'person', proposedValue: { name: 'Morgan Lee', title: 'President' } });
});
