import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type Color,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

export type LegalDocType = 'tos' | 'sa';

/** Everything needed to render a Certificate of Completion, all sourced from a
 * persisted onboard_consent row so the signed PDF is a deterministic function
 * of the record (no stored blob — regenerated on demand for download/email). */
export interface SignatureRecord {
  docType: LegalDocType;
  docVersion: string;
  signerName: string;
  signerTitle: string;
  /** The exact string the signer typed as their signature. */
  signatureName: string;
  signatureMethod: string;
  signerEmail: string;
  orgName: string;
  acceptedAt: Date;
  ip: string | null;
  userAgent: string | null;
  envelopeId: string;
  /** onboard_consent row id — the evidence anchor. */
  consentId: string;
  /** SHA-256 (hex) of the formal-PDF template this signature attests to. */
  docSha256: string;
}

interface DocMeta {
  asset: string;
  title: string;
  downloadName: string;
}

const DOC_META: Record<LegalDocType, DocMeta> = {
  tos: {
    asset: 'terms-of-service.pdf',
    title: 'Terms of Service',
    downloadName: 'Capiro-Terms-of-Service-signed.pdf',
  },
  sa: {
    asset: 'subscription-agreement.pdf',
    title: 'Subscription Agreement',
    downloadName: 'Capiro-Subscription-Agreement-signed.pdf',
  },
};

// Palette (matches the onboarding warm-paper design tokens).
const INK = rgb(0.082, 0.086, 0.102);
const MUTED = rgb(0.36, 0.37, 0.4);
const ACCENT = rgb(0.165, 0.341, 0.808);
const LINE = rgb(0.89, 0.878, 0.839);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const CONTENT_W = PAGE_W - MARGIN * 2;

/**
 * Builds the signed copy of a legal document: the original counsel-provided
 * formal PDF with an appended "Certificate of Completion" page carrying the
 * typed signature and the full audit trail. CommonJS build → assets resolve
 * relative to __dirname (dist/legal/assets at runtime, src/legal/assets under
 * ts-jest); no filesystem writes, no S3.
 */
@Injectable()
export class SignedPdfService {
  private readonly assetsDir = resolve(__dirname, 'assets');
  private readonly templateCache = new Map<LegalDocType, Buffer>();
  private readonly hashCache = new Map<LegalDocType, string>();

  downloadName(docType: LegalDocType): string {
    return DOC_META[docType].downloadName;
  }

  docTitle(docType: LegalDocType): string {
    return DOC_META[docType].title;
  }

  private async templateBytes(docType: LegalDocType): Promise<Buffer> {
    const cached = this.templateCache.get(docType);
    if (cached) return cached;
    const bytes = await readFile(resolve(this.assetsDir, DOC_META[docType].asset));
    this.templateCache.set(docType, bytes);
    return bytes;
  }

  /** SHA-256 (hex) of the exact formal-PDF template — bound into each consent
   * row so a signature attests to a specific document artifact. */
  async templateSha256(docType: LegalDocType): Promise<string> {
    const cached = this.hashCache.get(docType);
    if (cached) return cached;
    const hex = createHash('sha256')
      .update(await this.templateBytes(docType))
      .digest('hex');
    this.hashCache.set(docType, hex);
    return hex;
  }

  /** The formal document as-is (blank), for a "download the unsigned form" path. */
  async blankPdf(docType: LegalDocType): Promise<Buffer> {
    return this.templateBytes(docType);
  }

  /** The signed copy: formal PDF + appended Certificate of Completion. */
  async generateSigned(record: SignatureRecord): Promise<Buffer> {
    const src = await this.templateBytes(record.docType);
    const pdf = await PDFDocument.load(src);
    const fonts = {
      body: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      sig: await pdf.embedFont(StandardFonts.TimesRomanItalic),
      mono: await pdf.embedFont(StandardFonts.Courier),
    };
    this.drawCertificate(pdf.addPage([PAGE_W, PAGE_H]), fonts, record);
    const out = await pdf.save();
    return Buffer.from(out);
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private drawCertificate(
    page: PDFPage,
    fonts: { body: PDFFont; bold: PDFFont; sig: PDFFont; mono: PDFFont },
    r: SignatureRecord,
  ): void {
    const title = DOC_META[r.docType].title;
    let y = PAGE_H - MARGIN;

    const line = (text: string, font: PDFFont, size: number, color: Color = INK, x = MARGIN) => {
      page.drawText(text, { x, y, size, font, color });
    };
    const rule = (gap = 10) => {
      y -= gap;
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 0.75,
        color: LINE,
      });
      y -= gap;
    };
    const paragraph = (text: string, font: PDFFont, size: number, color: Color = INK, gap = 4) => {
      for (const ln of wrap(text, font, size, CONTENT_W)) {
        page.drawText(ln, { x: MARGIN, y, size, font, color });
        y -= size + gap;
      }
    };
    const kv = (label: string, value: string, valFont: PDFFont = fonts.body) => {
      page.drawText(label, { x: MARGIN, y, size: 9.5, font: fonts.body, color: MUTED });
      page.drawText(value, { x: MARGIN + 130, y, size: 9.5, font: valFont, color: INK });
      y -= 16;
    };

    // Header
    line('CAPIRO', fonts.bold, 13, ACCENT);
    y -= 26;
    line('Certificate of Completion', fonts.bold, 20);
    y -= 16;
    line('Electronic signature record', fonts.body, 10.5, MUTED);
    y -= 8;
    rule(10);

    // Document
    y -= 2;
    line('DOCUMENT', fonts.bold, 9, MUTED);
    y -= 16;
    line(title, fonts.bold, 12.5);
    y -= 15;
    line(`Version ${r.docVersion}`, fonts.body, 10, MUTED);
    y -= 24;

    // Signer
    line('SIGNER', fonts.bold, 9, MUTED);
    y -= 18;
    for (const [label, value] of [
      ['Name', r.signerName],
      ['Title', r.signerTitle],
      ['Email', r.signerEmail],
      ['Organization', r.orgName],
    ] as const) {
      page.drawText(label, { x: MARGIN, y, size: 10, font: fonts.body, color: MUTED });
      page.drawText(value || '—', { x: MARGIN + 110, y, size: 10.5, font: fonts.bold, color: INK });
      y -= 17;
    }
    y -= 10;

    // Signature block
    const boxTop = y;
    const boxH = 66;
    page.drawRectangle({
      x: MARGIN,
      y: boxTop - boxH,
      width: CONTENT_W,
      height: boxH,
      borderColor: LINE,
      borderWidth: 1,
      color: rgb(0.98, 0.976, 0.965),
    });
    page.drawText('SIGNATURE', {
      x: MARGIN + 14,
      y: boxTop - 20,
      size: 8.5,
      font: fonts.bold,
      color: MUTED,
    });
    page.drawText(`/s/  ${r.signatureName || r.signerName}`, {
      x: MARGIN + 14,
      y: boxTop - 48,
      size: 22,
      font: fonts.sig,
      color: INK,
    });
    const methodLabel =
      r.signatureMethod === 'typed'
        ? 'Signed electronically · typed signature'
        : `Signed electronically · ${r.signatureMethod}`;
    page.drawText(methodLabel, {
      x: PAGE_W - MARGIN - 14 - fonts.body.widthOfTextAtSize(methodLabel, 8.5),
      y: boxTop - boxH + 12,
      size: 8.5,
      font: fonts.body,
      color: MUTED,
    });
    y = boxTop - boxH - 22;

    // Legal statement
    paragraph(
      `By signing, ${r.signerName || 'the signer'} affirmed they are authorized to bind ` +
        `${r.orgName || 'the organization'} and agreed to this ${title} electronically. This ` +
        `electronic signature is intended to be legally binding under the U.S. ESIGN Act and ` +
        `applicable state UETA, and is the legal equivalent of a handwritten signature.`,
      fonts.body,
      10,
      MUTED,
      4,
    );
    y -= 12;
    rule(8);

    // Audit trail
    y -= 2;
    line('AUDIT TRAIL', fonts.bold, 9, MUTED);
    y -= 18;
    kv('Accepted', `${formatUtc(r.acceptedAt)}  (${r.acceptedAt.toISOString()})`);
    kv('IP address', r.ip ?? 'not recorded');
    kv('Device', truncate(r.userAgent ?? 'not recorded', 64));
    // SHA is long — label on its own line, hex in mono beneath.
    page.drawText('Document SHA-256', { x: MARGIN, y, size: 9.5, font: fonts.body, color: MUTED });
    y -= 15;
    page.drawText(r.docSha256, { x: MARGIN, y, size: 9, font: fonts.mono, color: INK });
    y -= 18;
    kv('Envelope ID', r.envelopeId, fonts.mono);
    kv('Record ID', r.consentId, fonts.mono);

    // Footer
    page.drawText('Generated by Capiro · legal@capiro.ai', {
      x: MARGIN,
      y: MARGIN - 24,
      size: 8.5,
      font: fonts.body,
      color: MUTED,
    });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function formatUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(date);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Greedy word-wrap with a hard char-break fallback for overlong tokens. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) lines.push(cur);
    cur = '';
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (font.widthOfTextAtSize(w, size) > maxWidth) {
      let cut = w.length;
      while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--;
      if (cur) flush();
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const trial = cur ? `${cur} ${w}` : w;
    if (cur && font.widthOfTextAtSize(trial, size) > maxWidth) {
      flush();
      cur = w;
    } else {
      cur = trial;
    }
  }
  flush();
  return lines;
}
