import { Injectable, NotFoundException } from '@nestjs/common';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import { PrismaService } from '../prisma/prisma.service.js';
import { anonymizeText, applyRedactions } from '../generation/anonymize.js';

/**
 * Decode a letterhead logo data URL (PNG/JPEG only — the formats docx can embed
 * as a raster ImageRun) and read its intrinsic dimensions so the export keeps
 * the logo's aspect ratio. Returns null for SVG/other/unparseable input so the
 * caller silently omits the logo rather than distorting or crashing the export.
 */
function decodeLogo(
  dataUrl: string | undefined,
): { type: 'png' | 'jpg'; data: Buffer; width: number; height: number } | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) return null;
  let data: Buffer;
  try {
    data = Buffer.from(m[2]!.replace(/\s/g, ''), 'base64');
  } catch {
    return null;
  }
  const isPng = /png/i.test(m[1]!);
  if (isPng) {
    // PNG IHDR: width @ byte 16 (BE u32), height @ byte 20.
    if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return null;
    return { type: 'png', data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // JPEG: scan segments for a Start-Of-Frame marker carrying height/width.
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < data.length) {
    if (data[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = data[off + 1]!;
    const len = data.readUInt16BE(off + 2);
    // SOF0..SOF15 except DHT(C4)/JPG(C8)/DAC(CC) carry frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = data.readUInt16BE(off + 5);
      const width = data.readUInt16BE(off + 7);
      if (width && height) return { type: 'jpg', data, width, height };
      return null;
    }
    off += 2 + len;
  }
  return null;
}

/**
 * Document export (Phase 7). Renders a draft to a .docx via the `docx` library
 * (MIT — already a vetted dependency in apps/api). PDF export is done
 * client-side via the browser print pipeline (a print stylesheet on the
 * Preview canvas), so no headless-Chrome dependency is added server-side.
 *
 * Honors the draft's anonymize flag: client/office names are stripped from the
 * exported text exactly as they are in generation/preview.
 */
@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async buildDocx(
    tenantId: string,
    draftId: string,
  ): Promise<{ filename: string; buffer: Buffer }> {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');

    const cfg = draft.config as Record<string, unknown>;
    const client = (cfg.client as string | null) ?? draft.client;
    const offices = (cfg.offices as string[] | undefined) ?? [];
    const sections = (cfg.sections as string[] | undefined) ?? [];
    const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    const letterhead = cfg.letterhead as
      | { custom?: boolean; firmName?: string; firmAddr?: string; logoDataUrl?: string }
      | undefined;

    // Anonymize behavior honors the review modal's choices (cfg.anonymizeMap):
    //  - exportMode 'original' → export the real names even when the flag is on.
    //  - a reviewed redaction map → use the approved terms/replacements.
    //  - no map (toggle-only) → fall back to the bare client/office default.
    // Per-term scope='this' is applied document-wide here (the export has no
    // per-mention offset to target): over-redacting is the fail-safe direction —
    // it never leaks a name the user approved for redaction.
    const anonymizeMap = cfg.anonymizeMap as
      | { redactions?: Array<{ from: string; to: string }>; exportMode?: 'anonymized' | 'original' }
      | undefined;
    const exportOriginal = anonymizeMap?.exportMode === 'original';
    const anonymize = Boolean(cfg.anonymize) && !exportOriginal;
    const redactions = anonymizeMap?.redactions ?? [];

    const redact = (text: string): string => {
      if (!anonymize) return text;
      if (redactions.length) return applyRedactions(text, redactions);
      return anonymizeText(text, { client, offices }).text;
    };

    const children: Paragraph[] = [];

    if (letterhead?.custom) {
      let lhHasContent = false;

      // Branded logo (PNG/JPEG). Scaled to a max 64pt height, aspect preserved;
      // SVG/unparseable logos are silently skipped (export must never crash).
      const logo = decodeLogo(letterhead.logoDataUrl);
      if (logo) {
        const maxH = 64;
        const height = Math.min(maxH, logo.height);
        const width = Math.max(1, Math.round((logo.width / logo.height) * height));
        children.push(
          new Paragraph({
            alignment: 'center',
            children: [
              new ImageRun({ type: logo.type, data: logo.data, transformation: { width, height } }),
            ],
          }),
        );
        lhHasContent = true;
      }

      if (letterhead.firmName) {
        children.push(
          new Paragraph({
            alignment: 'center',
            children: [new TextRun({ text: letterhead.firmName, bold: true, size: 28 })],
          }),
        );
        lhHasContent = true;
      }
      if (letterhead.firmAddr) {
        children.push(
          new Paragraph({
            alignment: 'center',
            children: [new TextRun({ text: letterhead.firmAddr, size: 18, color: '666666' })],
          }),
        );
        lhHasContent = true;
      }
      if (lhHasContent) children.push(new Paragraph({ text: '' }));
    }

    children.push(new Paragraph({ text: redact(draft.docTitle), heading: HeadingLevel.TITLE }));

    for (const s of sections) {
      children.push(new Paragraph({ text: redact(s), heading: HeadingLevel.HEADING_2 }));
      const body = content[s];
      if (body) {
        for (const para of redact(body).split(/\n{2,}/)) {
          children.push(new Paragraph({ children: [new TextRun(para.trim())] }));
        }
      } else {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `[${redact(s)} — not yet drafted]`,
                italics: true,
                color: '999999',
              }),
            ],
          }),
        );
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    const safeTitle = (draft.docTitle || 'document')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return { filename: `${safeTitle || 'document'}.docx`, buffer };
  }
}
