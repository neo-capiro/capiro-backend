import { resolveAttachmentReference, type AttachmentReferenceCandidate } from './meri-attachment-reference.js';

const candidates: AttachmentReferenceCandidate[] = [
  { id: 'old', filename: 'Budget.pdf', turn: 1, uploadedAt: '2026-01-01T00:00:00Z', state: 'ready' },
  { id: 'new', filename: 'Budget.pdf', turn: 3, uploadedAt: '2026-02-01T00:00:00Z', state: 'partial' },
  { id: 'memo', filename: 'Memo.docx', turn: 2, uploadedAt: '2026-01-15T00:00:00Z', state: 'ready' },
];

describe('resolveAttachmentReference', () => {
  test('matches exact, case-insensitive, and stem references', () => {
    expect(resolveAttachmentReference('Memo.docx', candidates)).toEqual({ kind: 'unique', id: 'memo' });
    expect(resolveAttachmentReference('memo.DOCX', candidates)).toEqual({ kind: 'unique', id: 'memo' });
    expect(resolveAttachmentReference('memo', candidates)).toEqual({ kind: 'unique', id: 'memo' });
  });

  test('returns candidates rather than silently selecting duplicate filenames', () => {
    expect(resolveAttachmentReference('Budget.pdf', candidates)).toEqual({
      kind: 'ambiguous', candidates: candidates.slice(0, 2),
    });
  });

  test('can explicitly select latest and otherwise reports none', () => {
    expect(resolveAttachmentReference('budget', candidates, true)).toEqual({ kind: 'unique', id: 'new' });
    expect(resolveAttachmentReference('missing.pdf', candidates)).toEqual({ kind: 'none' });
  });
});
