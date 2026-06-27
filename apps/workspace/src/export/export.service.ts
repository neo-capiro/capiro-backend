import { Injectable, NotFoundException } from '@nestjs/common';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { PrismaService } from '../prisma/prisma.service.js';
import { anonymizeText, applyRedactions } from '../generation/anonymize.js';

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
      | { custom?: boolean; firmName?: string; firmAddr?: string }
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

    if (letterhead?.custom && letterhead.firmName) {
      children.push(
        new Paragraph({
          alignment: 'center',
          children: [new TextRun({ text: letterhead.firmName, bold: true, size: 28 })],
        }),
      );
      if (letterhead.firmAddr) {
        children.push(
          new Paragraph({
            alignment: 'center',
            children: [new TextRun({ text: letterhead.firmAddr, size: 18, color: '666666' })],
          }),
        );
      }
      children.push(new Paragraph({ text: '' }));
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
