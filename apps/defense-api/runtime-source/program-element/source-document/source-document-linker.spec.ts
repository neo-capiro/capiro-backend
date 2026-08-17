import { chooseDocumentForUrlRow, exhibitToDocumentType, type LinkCandidate } from './source-document-linker.js';

describe('exhibitToDocumentType', () => {
  it('maps exhibit labels to documentTypes', () => {
    expect(exhibitToDocumentType('R-1')).toBe('r1');
    expect(exhibitToDocumentType('R-2')).toBe('r2');
    expect(exhibitToDocumentType('R-2A')).toBe('r2');
    expect(exhibitToDocumentType('R-3')).toBe('r3');
    expect(exhibitToDocumentType('P-1')).toBe('p1');
    expect(exhibitToDocumentType('P-40')).toBe('p40');
    expect(exhibitToDocumentType(null)).toBeNull();
    expect(exhibitToDocumentType('weird')).toBeNull();
  });
});

describe('chooseDocumentForUrlRow', () => {
  const URL = 'https://comptroller.war.gov/.../RDTE_Vol1_DARPA_Master.pdf';
  // One PDF backs both an r2 and an r3 document (the real DARPA case).
  const darpa: LinkCandidate[] = [
    { id: 'doc-r2', documentType: 'r2', sourceUrl: URL },
    { id: 'doc-r3', documentType: 'r3', sourceUrl: URL },
  ];

  it('disambiguates same-URL r2/r3 by program_element_source.exhibitType', () => {
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: 'R-3' }, darpa).documentId).toBe('doc-r3');
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: 'R-2A' }, darpa).documentId).toBe('doc-r2');
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: 'R-2' }, darpa).documentId).toBe('doc-r2');
  });

  it('honors an explicit expectedDocumentType (project -> r2, performer -> r3)', () => {
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, expectedDocumentType: 'r2' }, darpa).documentId).toBe('doc-r2');
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, expectedDocumentType: 'r3' }, darpa).documentId).toBe('doc-r3');
  });

  it('links to the single document when a URL is unambiguous', () => {
    const only: LinkCandidate[] = [{ id: 'doc-x', documentType: 'r2', sourceUrl: URL }];
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: 'R-2' }, only).documentId).toBe('doc-x');
    // exhibit with no typed candidate falls back to the lone URL match.
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: 'R-9' }, only).documentId).toBe('doc-x');
  });

  it('returns null with a reason when it cannot decide', () => {
    expect(chooseDocumentForUrlRow({ sourceUrl: null }, darpa).documentId).toBeNull();
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: null }, []).documentId).toBeNull();
    const ambiguous = chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: null }, darpa);
    expect(ambiguous.documentId).toBeNull();
    expect(ambiguous.reason).toMatch(/ambiguous/);
  });

  it('breaks deterministic ties on lowest id when multiple docs share URL + documentType', () => {
    const dup: LinkCandidate[] = [
      { id: 'doc-2', documentType: 'r2', sourceUrl: URL },
      { id: 'doc-1', documentType: 'r2', sourceUrl: URL },
    ];
    expect(chooseDocumentForUrlRow({ sourceUrl: URL, exhibitType: 'R-2' }, dup).documentId).toBe('doc-1');
  });
});
