import { looksLikePdf } from './meri-scrape.helpers.js';

describe('looksLikePdf', () => {
  it('detects the PDF content type regardless of params/case', () => {
    expect(looksLikePdf('application/pdf', 'https://example.com/doc')).toBe(true);
    expect(looksLikePdf('application/pdf; charset=binary', 'https://example.com/doc')).toBe(true);
    expect(looksLikePdf('Application/PDF', 'https://example.com/doc')).toBe(true);
    expect(looksLikePdf('application/x-pdf', 'https://example.com/doc')).toBe(true);
  });

  it('falls back to a .pdf URL path when the content type is generic', () => {
    expect(looksLikePdf('application/octet-stream', 'https://gao.gov/assets/report.pdf')).toBe(true);
    expect(looksLikePdf('', 'https://gao.gov/assets/REPORT.PDF')).toBe(true);
    expect(looksLikePdf(null, 'https://gao.gov/assets/report.pdf?download=1')).toBe(true);
  });

  it('is false for HTML pages and non-pdf URLs', () => {
    expect(looksLikePdf('text/html', 'https://example.com/page')).toBe(false);
    expect(looksLikePdf('text/html; charset=utf-8', 'https://example.com/page.pdf.html')).toBe(false);
    expect(looksLikePdf('', 'https://example.com/page')).toBe(false);
    expect(looksLikePdf(null, null)).toBe(false);
  });

  it('does not treat a .pdf query param as a pdf path', () => {
    expect(looksLikePdf('text/html', 'https://example.com/view?file=report.pdf')).toBe(false);
  });
});
