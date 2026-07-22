import { PDFDocument } from 'pdf-lib';
import { SignedPdfService, type SignatureRecord } from './signed-pdf.service.js';

/** Exercises real PDF generation against the counsel-provided formal templates
 * in src/legal/assets (resolved via __dirname under ts-jest). */
describe('SignedPdfService', () => {
  const svc = new SignedPdfService();

  const record = (over: Partial<SignatureRecord> = {}): SignatureRecord => ({
    docType: 'sa',
    docVersion: '2026.07-v1-trial',
    signerName: 'Jane Doe',
    signerTitle: 'Managing Partner',
    signatureName: 'Jane Doe',
    signatureMethod: 'typed',
    signerEmail: 'jane@firm.example',
    orgName: 'Keel Defense LLC',
    acceptedAt: new Date('2026-07-22T15:04:05.000Z'),
    ip: '203.0.113.7',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    envelopeId: '00000000-0000-0000-0000-000000000001',
    consentId: 'consent-abc',
    docSha256: 'a'.repeat(64),
    ...over,
  });

  it.each(['tos', 'sa'] as const)(
    'appends exactly one Certificate of Completion page to the %s template',
    async (docType) => {
      const blank = await PDFDocument.load(await svc.blankPdf(docType));
      const signedBytes = await svc.generateSigned(record({ docType }));
      expect(signedBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const signed = await PDFDocument.load(signedBytes);
      expect(signed.getPageCount()).toBe(blank.getPageCount() + 1);
    },
  );

  it('produces a stable 64-hex template hash (cached)', async () => {
    const a = await svc.templateSha256('sa');
    const b = await svc.templateSha256('sa');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('renders without throwing when ip/userAgent are missing', async () => {
    const bytes = await svc.generateSigned(
      record({ docType: 'tos', ip: null, userAgent: null, signerTitle: '' }),
    );
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('exposes download names and titles per doc type', () => {
    expect(svc.downloadName('tos')).toMatch(/Terms-of-Service-signed\.pdf$/);
    expect(svc.downloadName('sa')).toMatch(/Subscription-Agreement-signed\.pdf$/);
    expect(svc.docTitle('sa')).toBe('Subscription Agreement');
  });
});
