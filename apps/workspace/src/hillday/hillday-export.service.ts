import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service.js';
import { DirectoryBridgeClient } from './directory-bridge.client.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import type { HillDayDocumentView } from './hillday.types.js';

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
      const logo = view.client.hasLogo ? await this.fetchLogo(tenantId, view.client.id) : null;
      const buffer = await this.renderPdf(view, { pageSize, logo });
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

  private async fetchLogo(tenantId: string, clientId: string): Promise<Buffer | null> {
    const branding = await this.bridge.branding(tenantId, clientId);
    if (!branding.ok || !branding.data.clientLogoUrl) return null;
    const type = (branding.data.clientLogoContentType ?? '').toLowerCase();
    // pdfkit embeds PNG and JPEG only; SVG/WEBP marks fall back to the monogram.
    if (!/image\/(png|jpe?g)/.test(type)) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(branding.data.clientLogoUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length <= MAX_LOGO_BYTES ? bytes : null;
    } catch (err) {
      this.logger.warn(`sponsor logo fetch failed: ${(err as Error).message}`);
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

    // ── Cover ──
    const ruleY = doc.y;
    if (opts.logo) {
      try {
        doc.image(opts.logo, left, ruleY, { fit: [96, 22] });
      } catch {
        this.monogram(doc, left, ruleY, view.client.mono);
      }
    } else {
      this.monogram(doc, left, ruleY, view.client.mono);
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(view.client.name, left + 108, ruleY + 5, {
      width: width / 2,
      lineBreak: false,
    });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(view.firm.name, left + width / 2, ruleY + 6, {
      width: width / 2,
      align: 'right',
      lineBreak: false,
    });
    doc.y = ruleY + 30;
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).lineWidth(1).stroke();
    doc.y += 26;

    doc.font('Helvetica-Bold').fontSize(26).fillColor(INK).text(view.cover.title, left, doc.y, { width });
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10.5).fillColor(GRAY).text(view.cover.dateline, { width: width * 0.8 });
    doc.moveDown(1.2);

    // Six-cell fact grid (3 × 2).
    const cellW = width / 3;
    const gridTop = doc.y;
    view.cover.facts.forEach((f, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = left + col * cellW;
      const y = gridTop + row * 46;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(LIGHT).text(f.k.toUpperCase(), x, y, { width: cellW - 12, characterSpacing: 0.6 });
      doc.font('Helvetica').fontSize(11).fillColor(INK).text(f.v, x, y + 12, { width: cellW - 12, lineBreak: false, ellipsis: true });
    });
    doc.y = gridTop + 2 * 46 + 10;

    // Executive summary table — generated from the same rows as the sections.
    doc.font('Helvetica-Bold').fontSize(7).fillColor(LIGHT).text('THE DAY AT A GLANCE', left, doc.y, { characterSpacing: 0.6 });
    doc.y += 12;
    const cols = [
      { k: 'time', label: 'Time', w: 58 },
      { k: 'member', label: 'Member', w: 150 },
      { k: 'office', label: 'Office', w: 112 },
      { k: 'room', label: 'Room', w: 78 },
      { k: 'minutes', label: 'Min', w: 30 },
      { k: 'staffLead', label: 'Staff lead', w: width - 428 },
    ] as const;
    const drawRow = (values: Record<string, string>, header: boolean) => {
      ensure(20);
      const y = doc.y;
      let x = left;
      for (const c of cols) {
        doc
          .font(header ? 'Helvetica-Bold' : c.k === 'member' ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(header ? 7 : 9)
          .fillColor(header ? LIGHT : c.k === 'time' ? NAVY : INK)
          .text(header ? c.label.toUpperCase() : values[c.k] ?? '', x, y + 4, {
            width: c.w - 6,
            lineBreak: false,
            ellipsis: true,
            characterSpacing: header ? 0.6 : 0,
          });
        x += c.w;
      }
      doc.y = y + 20;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
    };
    drawRow({}, true);
    for (const r of view.summary) {
      drawRow(
        { time: r.time, member: r.member, office: r.office, room: r.room, minutes: r.minutes, staffLead: r.staffLead },
        false,
      );
    }
    if (!view.summary.length) {
      doc.font('Helvetica').fontSize(9).fillColor(GRAY).text('No meetings selected.', left, doc.y + 6);
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
        this.heading(doc, 'Focus');
        this.body(doc, s.focus ?? 'Focus not available.', width, left);
        this.heading(doc, 'Background');
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

      const flagged = s.flags.filter((f) => f.kind !== 'user_edited' && f.kind !== 'generation_failed');
      if (flagged.length) {
        doc.moveDown(0.4);
        for (const f of flagged) {
          ensure(16);
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(WARN).text(`Flag · ${flagLabel(f.kind)}: ${f.detail}`, left, doc.y, { width });
        }
      }
    }

    // ── Provenance ──
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(NAVY).text('PROVENANCE', left, doc.y, { characterSpacing: 0.6 });
    doc.y += 12;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('Sources used', { width });
    doc.moveDown(0.6);
    for (const sc of view.provenance.sourceCounts) {
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(`${sc.label}: ${sc.detail ?? sc.count}`, { width });
    }
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Manual corrections that govern', { width });
    doc.moveDown(0.2);
    if (view.provenance.corrections.length) {
      for (const c of view.provenance.corrections) {
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(`• ${c}`, { width });
      }
    } else {
      doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('None. Every office and attendee is as the Directory resolved it.', { width });
    }
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text(
      `Generated ${view.provenance.generatedAt ?? 'not yet'}${view.provenance.model ? ` · model ${view.provenance.model}` : ''}${
        view.provenance.failedUnits ? ` · ${view.provenance.failedUnits} section(s) unavailable` : ''
      } · revision ${view.cover.facts.find((f) => f.k === 'Revision')?.v ?? '1'}`,
      { width },
    );

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
    doc.roundedRect(x, y, 24, 24, 5).fillColor(NAVY).fill();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF').text(mono.slice(0, 2), x, y + 7, { width: 24, align: 'center', lineBreak: false });
  }

  private heading(doc: PdfDoc, text: string): void {
    if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(INK).text(text);
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

function flagLabel(kind: string): string {
  switch (kind) {
    case 'unsupported_claim':
      return 'Unsupported claim';
    case 'needs_confirmation':
      return 'Needs confirmation';
    case 'partial_resolution':
      return 'Partial resolution';
    default:
      return kind.replace(/_/g, ' ');
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
