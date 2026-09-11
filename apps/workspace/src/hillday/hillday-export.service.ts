import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service.js';
import { DirectoryBridgeClient } from './directory-bridge.client.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import { SUMMARY_COLUMN_KEYS, type HillDayDocumentView, type SummaryColumnKey } from './hillday.types.js';

/**
 * PDF export (requirements §8): print-based, paginated on the server-rendered
 * document model — never a screenshot. Letter by default, A4 available. A
 * section break never splits a facts grid. The export stores the rendered bytes
 * so the signed URL always serves exactly what was rendered.
 *
 * Colour constants below are PDF ink values for the server renderer; the "no
 * raw colour" foundation rule governs web markup, which this is not.
 */
const INK = '#101828';
const NAVY = '#294E68';
const GRAY = '#475467';
const LIGHT = '#98A2B3';
const RULE = '#E4E7EC';
const WARN = '#B54708';
const WARN_BG = '#FFFCF5';
const NAVY_BG = '#EDF3F7';
const ZEBRA = '#F9FAFB';

const SIGNED_URL_TTL_MS = 60 * 60 * 1000;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export interface ExportView {
  exportId: string;
  documentId: string;
  status: 'queued' | 'ready' | 'failed';
  format: 'pdf';
  pageSize: 'letter' | 'a4';
  filename: string | null;
  sizeBytes: number | null;
  url: string | null;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
}

type PdfDoc = InstanceType<typeof PDFDocument>;

@Injectable()
export class HillDayExportService {
  private readonly logger = new Logger(HillDayExportService.name);
  private readonly signingSecret =
    process.env.WORKSPACE_EXPORT_SIGNING_SECRET ?? process.env.INTERNAL_SERVICE_SECRET ?? randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: HillDayDocumentService,
    private readonly bridge: DirectoryBridgeClient,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    documentId: string,
    pageSize: 'letter' | 'a4',
  ): Promise<ExportView> {
    const doc = await this.documents.assertDoc(tenantId, documentId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can export it');
    const view = await this.documents.get(tenantId, documentId);
    const row = await this.prisma.wsHillDayExport.create({
      data: { tenantId, documentId, actorId, format: 'pdf', pageSize, status: 'queued' },
    });
    try {
      const branding = await this.fetchBranding(tenantId, view.client.id);
      const buffer = await this.renderPdf(view, { pageSize, logo: branding.clientLogo });
      const filename = `${safeFilename(view.name)}.pdf`;
      const ready = await this.prisma.wsHillDayExport.update({
        where: { id: row.id },
        data: { status: 'ready', file: buffer, sizeBytes: buffer.length, filename, readyAt: new Date() },
      });
      return this.toView(ready);
    } catch (err) {
      this.logger.error(`Hill Day export ${row.id} failed: ${(err as Error).message}`);
      const failed = await this.prisma.wsHillDayExport.update({
        where: { id: row.id },
        data: { status: 'failed', error: (err as Error).message.slice(0, 500) },
      });
      return this.toView(failed);
    }
  }

  async get(tenantId: string, documentId: string, exportId: string): Promise<ExportView> {
    const row = await this.prisma.wsHillDayExport.findFirst({ where: { id: exportId, tenantId, documentId } });
    if (!row) throw new NotFoundException('Export not found');
    return this.toView(row);
  }

  /** Serve the file for a signed URL (no session — the signature is the grant). */
  async file(
    documentId: string,
    exportId: string,
    exp: string,
    sig: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const expiresAt = Number.parseInt(exp, 10);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      throw new ForbiddenException('This download link has expired');
    }
    const expected = this.sign(documentId, exportId, expiresAt);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Invalid download signature');
    }
    const row = await this.prisma.wsHillDayExport.findFirst({ where: { id: exportId, documentId } });
    if (!row || row.status !== 'ready' || !row.file) throw new NotFoundException('Export not ready');
    return { buffer: Buffer.from(row.file), filename: row.filename ?? 'hill-day-schedule.pdf' };
  }

  signedPath(documentId: string, exportId: string, expiresAt: number): string {
    const sig = this.sign(documentId, exportId, expiresAt);
    return `/workspace-api/hillday/files/${documentId}/${exportId}?exp=${expiresAt}&sig=${sig}`;
  }

  private sign(documentId: string, exportId: string, expiresAt: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${documentId}:${exportId}:${expiresAt}`)
      .digest('hex');
  }

  private toView(row: {
    id: string;
    documentId: string;
    status: string;
    pageSize: string;
    filename: string | null;
    sizeBytes: number | null;
    error: string | null;
    createdAt: Date;
  }): ExportView {
    const ready = row.status === 'ready';
    const expiresAt = ready ? Date.now() + SIGNED_URL_TTL_MS : null;
    return {
      exportId: row.id,
      documentId: row.documentId,
      status: row.status as ExportView['status'],
      format: 'pdf',
      pageSize: row.pageSize === 'a4' ? 'a4' : 'letter',
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      url: expiresAt ? this.signedPath(row.documentId, row.id, expiresAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The sponsor's own mark for the cover header — the only branding the
   *  client-facing packet carries. */
  private async fetchBranding(tenantId: string, clientId: string): Promise<{ clientLogo: Buffer | null }> {
    const branding = await this.bridge.branding(tenantId, clientId);
    if (!branding.ok) return { clientLogo: null };
    const clientLogo = await this.downloadLogo(branding.data.clientLogoUrl, branding.data.clientLogoContentType);
    return { clientLogo };
  }

  private async downloadLogo(url: string | null, contentType: string | null): Promise<Buffer | null> {
    if (!url) return null;
    const type = (contentType ?? '').toLowerCase();
    // pdfkit embeds PNG and JPEG only; SVG/WEBP marks fall back to the monogram/text.
    if (!/image\/(png|jpe?g)/.test(type)) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length <= MAX_LOGO_BYTES ? bytes : null;
    } catch (err) {
      this.logger.warn(`logo fetch failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Renderer ──────────────────────────────────────────────────────────────

  async renderPdf(
    view: HillDayDocumentView,
    opts: { pageSize: 'letter' | 'a4'; logo: Buffer | null },
  ): Promise<Buffer> {
    const doc = new PDFDocument({
      size: opts.pageSize === 'a4' ? 'A4' : 'LETTER',
      margins: { top: 54, bottom: 60, left: 54, right: 54 },
      bufferPages: true,
      info: { Title: view.name, Author: view.firm.name, Subject: `${view.blueprint.name} — ${view.client.name}` },
    });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (height: number) => {
      if (doc.y + height > bottom()) doc.addPage();
    };
    const assertFitsPage = (height: number, label: string, reservedHeight = 0) => {
      if (!Number.isFinite(height) || height > bottom() - doc.page.margins.top - reservedHeight) {
        doc.destroy();
        throw new BadRequestException(`${label} is too tall for one PDF page. Shorten the text or remove extra line breaks, then export again`);
      }
    };

    // ── Cover ──
    // Header carries only the sponsor's own mark — no Capiro branding here;
    // the firm is already named in the "prepared by" fact below.
    const ruleY = doc.y;
    const LOGO_W = 116;
    const LOGO_H = 36;
    if (opts.logo) {
      try {
        doc.image(opts.logo, left, ruleY, { fit: [LOGO_W, LOGO_H] });
      } catch {
        this.monogram(doc, left, ruleY, view.client.mono);
      }
    } else {
      this.monogram(doc, left, ruleY, view.client.mono);
    }
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(view.client.name, left + LOGO_W + 20, ruleY + LOGO_H / 2 - 7, {
      width: width - LOGO_W - 20,
      lineBreak: false,
    });
    doc.y = ruleY + LOGO_H + 8;
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).lineWidth(1).stroke();
    doc.y += 26;

    doc.font('Helvetica-Bold').fontSize(26).fillColor(INK);
    const titleHeight = doc.heightOfString(view.cover.title, { width });
    assertFitsPage(titleHeight, 'Cover title');
    ensure(titleHeight);
    doc.text(view.cover.title, left, doc.y, { width });
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10.5).fillColor(GRAY);
    const datelineHeight = doc.heightOfString(view.cover.dateline, { width: width * 0.8 });
    assertFitsPage(datelineHeight, 'Cover dateline');
    ensure(datelineHeight);
    doc.text(view.cover.dateline, left, doc.y, { width: width * 0.8 });
    doc.moveDown(1.2);

    // Values can be edited: wrap and measure each row instead of truncating.
    const cellW = width / 3;
    for (let i = 0; i < view.cover.facts.length; i += 3) {
      const facts = view.cover.facts.slice(i, i + 3);
      doc.font('Helvetica').fontSize(11);
      const rowH = Math.max(46, ...facts.map((f) => doc.heightOfString(f.v, { width: cellW - 12 }) + 28));
      assertFitsPage(rowH, `Cover facts (${facts.map((f) => f.k).join(', ')})`);
      ensure(rowH);
      const top = doc.y;
      facts.forEach((f, col) => {
        const x = left + col * cellW;
        doc.font('Helvetica-Bold').fontSize(7).fillColor(LIGHT).text(f.k.toUpperCase(), x, top, { width: cellW - 12, characterSpacing: 0.6 });
        doc.font('Helvetica').fontSize(11).fillColor(INK).text(f.v, x, top + 12, { width: cellW - 12 });
      });
      doc.y = top + rowH;
    }
    doc.y += 10;

    // Use the same visible columns and overridden rows as the draft screen.
    ensure(56);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(LIGHT).text('THE DAY AT A GLANCE', left, doc.y, { characterSpacing: 0.6 });
    doc.y += 12;
    const definitions: Record<SummaryColumnKey, { label: string; weight: number }> = {
      time: { label: 'Time', weight: 58 },
      member: { label: 'Member', weight: 150 },
      office: { label: 'Office', weight: 112 },
      room: { label: 'Room', weight: 78 },
      minutes: { label: 'Min', weight: 30 },
      staffLead: { label: 'Staff lead', weight: width - 428 },
    };
    const visible = new Set(view.summaryColumns ?? SUMMARY_COLUMN_KEYS);
    const keys = SUMMARY_COLUMN_KEYS.filter((key) => visible.has(key));
    const totalWeight = keys.reduce((sum, key) => sum + definitions[key].weight, 0);
    const cols = keys.map((k) => ({ k, label: definitions[k].label, w: definitions[k].weight * width / totalWeight }));
    const HEADER_H = 22;
    const ROW_PAD = 16;
    const tableTop = doc.y;
    const pagesBefore = doc.bufferedPageRange().count;
    // Row height is measured from the tallest wrapped column, not a fixed
    // constant — a long room address wraps to several lines, and a fixed
    // row height let that wrapped text bleed into the row drawn after it.
    const rowHeight = (values: Record<string, string>): number => {
      let maxH = 0;
      for (const c of cols) {
        doc.font(c.k === 'member' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        maxH = Math.max(maxH, doc.heightOfString(values[c.k] ?? '', { width: c.w - 14 }));
      }
      return Math.max(24, maxH + ROW_PAD);
    };
    const drawRow = (values: Record<string, string>, opts: { header?: boolean; zebra?: boolean; rowNumber?: number }) => {
      const h = opts.header ? HEADER_H : rowHeight(values);
      if (!opts.header) assertFitsPage(h, `Schedule row ${opts.rowNumber ?? ''}`.trim(), HEADER_H);
      if (doc.y + h > bottom()) {
        doc.addPage();
        if (!opts.header) drawRow({}, { header: true });
      }
      const y = doc.y;
      if (opts.header) {
        doc.rect(left, y, width, h).fillColor(NAVY_BG).fill();
      } else if (opts.zebra) {
        doc.rect(left, y, width, h).fillColor(ZEBRA).fill();
      }
      let x = left;
      for (const c of cols) {
        doc
          .font(opts.header ? 'Helvetica-Bold' : c.k === 'member' ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(opts.header ? 7 : 9)
          .fillColor(opts.header ? NAVY : c.k === 'time' ? NAVY : INK)
          .text(opts.header ? c.label.toUpperCase() : values[c.k] ?? '', x + 10, y + (opts.header ? 8 : 7), {
            width: c.w - 14,
            characterSpacing: opts.header ? 0.6 : 0,
          });
        x += c.w;
      }
      doc.y = y + h;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
    };
    drawRow({}, { header: true });
    view.summary.forEach((r, i) => {
      drawRow(
        { time: r.time, member: r.member, office: r.office, room: r.room, minutes: r.minutes, staffLead: r.staffLead },
        { zebra: i % 2 === 1, rowNumber: i + 1 },
      );
    });
    if (!view.summary.length) {
      doc.font('Helvetica').fontSize(9).fillColor(GRAY).text('No meetings selected.', left + 10, doc.y + 6);
      doc.y += 24;
    }
    // Outer rule around the whole table — only when it stayed on one page;
    // a table long enough to paginate would otherwise draw a border
    // referencing a y-coordinate from the page it started on.
    if (doc.bufferedPageRange().count === pagesBefore) {
      doc.roundedRect(left, tableTop, width, doc.y - tableTop, 4).strokeColor(RULE).lineWidth(1).stroke();
    }

    // ── Sections ──
    for (const s of view.sections) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY).text(`MEETING ${s.number} · ${s.time.toUpperCase()} · ${s.duration.toUpperCase()}`, left, doc.y, { characterSpacing: 0.6 });
      doc.y += 12;
      doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(s.member, { width });
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY).text(s.subline || ' ', { width });
      doc.moveDown(0.8);

      // Facts grid (2 × 2), never split across pages.
      const factW = width / 2;
      const factHeights = s.facts.map((f) => {
        doc.font('Helvetica').fontSize(9.5);
        return 12 + doc.heightOfString(f.v, { width: factW - 14 }) + 8;
      });
      const rowH = [Math.max(factHeights[0] ?? 0, factHeights[1] ?? 0), Math.max(factHeights[2] ?? 0, factHeights[3] ?? 0)];
      const gridH = rowH[0]! + rowH[1]! + 12;
      ensure(gridH);
      const top = doc.y;
      doc.rect(left, top, width, gridH).fillColor(NAVY_BG).fill();
      s.facts.forEach((f, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = left + col * factW + 8;
        const y = top + 6 + (row === 1 ? rowH[0]! : 0);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(LIGHT).text(f.k.toUpperCase(), x, y, { characterSpacing: 0.6 });
        doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(f.v, x, y + 11, { width: factW - 14 });
      });
      doc.y = top + gridH + 14;

      if (s.status === 'done') {
        this.heading(doc, 'Focus', left, width);
        this.body(doc, s.focus ?? 'Focus not available.', width, left);
        this.heading(doc, 'Background', left, width);
        this.body(doc, s.background ?? 'Background not available.', width, left);
      } else {
        ensure(64);
        const y = doc.y;
        const text = `Section unavailable — ${humanReason(s.reason)}. The facts above are from the calendar and the Directory; regenerate this section from the editor.`;
        doc.font('Helvetica').fontSize(9.5);
        const h = doc.heightOfString(text, { width: width - 24 }) + 20;
        doc.rect(left, y, width, h).fillColor(WARN_BG).fill();
        doc.fillColor(WARN).text(text, left + 12, y + 10, { width: width - 24 });
        doc.y = y + h + 12;
      }
      // Internal QA flags (partial resolution, needs confirmation, etc.) stay
      // in the editor for the preparer to see — they're not something a
      // client-facing packet should surface.
    }

    // Provenance (sources used, manual corrections, model/revision) is
    // internal working detail for the preparer — it stays in the editor's
    // "Sources used" panel and is not rendered into the client-facing PDF.

    // ── Running footer with page numbers ──
    // The footer sits inside the bottom margin. pdfkit auto-adds a page when
    // text is placed past `page.maxY()` (which honours margins.bottom), so the
    // margin is zeroed while the footer is written and restored afterwards.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 40;
      doc.font('Helvetica').fontSize(8).fillColor(LIGHT);
      doc.text(`${view.client.name} · ${view.firm.name} · ${view.blueprint.name}`, left, y, { width: width * 0.7, lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width * 0.7, y, { width: width * 0.3, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
    return done;
  }

  private monogram(doc: PdfDoc, x: number, y: number, mono: string): void {
    doc.roundedRect(x, y, 36, 36, 6).fillColor(NAVY).fill();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#FFFFFF').text(mono.slice(0, 2), x, y + 11, { width: 36, align: 'center', lineBreak: false });
  }

  private heading(doc: PdfDoc, text: string, left: number, width: number): void {
    if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    // Explicit x — without it this inherits doc.x from whatever the last
    // absolutely-positioned call left it at (the facts grid's right column),
    // so "Focus" rendered shifted into the middle of the page while
    // "Background" (coming after body()'s own explicit left) looked fine.
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK).text(text, left, doc.y, { width });
    doc.moveDown(0.25);
  }

  private body(doc: PdfDoc, text: string, width: number, left: number): void {
    doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(text, left, doc.y, { width, lineGap: 2.5 });
    doc.moveDown(0.9);
  }
}

function humanReason(reason: string | null): string {
  switch (reason) {
    case 'model_credential_missing':
      return 'no model credential is configured for this firm';
    case 'provider_unavailable':
      return 'the generation provider was unavailable';
    case 'provider_timeout':
      return 'the generation provider timed out';
    case 'provider_output_unparseable':
      return 'the model reply could not be read';
    case null:
      return 'not generated yet';
    default:
      return reason.replace(/_/g, ' ');
  }
}

function safeFilename(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._ -]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'hill-day-schedule'
  );
}
