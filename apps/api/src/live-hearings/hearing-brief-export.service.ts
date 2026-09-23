/**
 * Turns a reviewed LegiWatch hearing brief (the same title/sections the user
 * sees in CreateBriefDialog, after any Meri chat edits) into a client-ready
 * Word document — either as a direct download, or auto-filed to the client's
 * Documents, mirroring the district-brief "auto-file" pattern.
 */
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ClientDocumentWriterService } from '../client-documents/client-document-writer.service.js';
import {
  DOCX_MIME,
  formatMemoDate,
  renderMemoDocx,
  type MemoDocInput,
} from '../intelligence/alert-memo/alert-memo-docx.js';

export interface BriefExportSection {
  name: string;
  /** Sanitized Workspace section HTML (`<p>`/`<ul>`/`<ol>`/`<li>`/`<strong>`/`<em>`). */
  content: string;
}

export interface BriefExportInput {
  title: string;
  mode: 'preparation' | 'recap';
  sections: BriefExportSection[];
  sources?: Array<Record<string, unknown>>;
  clientName?: string;
}

const NO_CONTENT_PLACEHOLDER = 'This section had no content.';

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&');
}

/** Sanitized section HTML → one plain-text line per block/list item, matching
 *  how `markdownToMemoDocInput` already turns hand-authored sections into the
 *  paragraph strings `renderMemoDocx` renders. */
export function htmlToParagraphs(html: string): string[] {
  const marked = (html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|ul|ol|tr|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(marked)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/** The brief's `sources` are heterogeneous kind-tagged records (hearing,
 *  official_page, intelligence_finding, model_cited); map each to the plain
 *  `{label, url}` shape the memo's Sources section already renders. */
export function sourceToMemoSource(source: Record<string, unknown>): {
  label: string;
  url?: string | null;
} {
  const kind = typeof source.kind === 'string' ? source.kind : undefined;
  if (kind === 'official_page') {
    return { label: 'Official hearing page', url: typeof source.url === 'string' ? source.url : null };
  }
  if (kind === 'hearing') {
    return { label: 'Hearing detail', url: typeof source.path === 'string' ? source.path : null };
  }
  if (kind === 'intelligence_finding') {
    return { label: 'Intelligence finding referenced in this brief', url: null };
  }
  if (kind === 'model_cited') {
    return { label: typeof source.label === 'string' ? source.label : 'Cited source', url: null };
  }
  return {
    label: typeof source.label === 'string' ? source.label : kind || 'Source',
    url: typeof source.url === 'string' ? source.url : null,
  };
}

export function briefToMemoDocInput(input: BriefExportInput): MemoDocInput {
  return {
    clientName: input.clientName?.trim() || 'All Clients',
    dateStr: formatMemoDate(),
    reLine: input.title,
    sections: input.sections.map((s) => {
      const paragraphs = htmlToParagraphs(s.content);
      // renderMemoDocx skips a section with zero paragraphs entirely (heading
      // and all) — the reviewed brief still shows this section's heading with
      // empty content, so an honest placeholder keeps the export consistent
      // with what the user reviewed.
      return { heading: s.name, paragraphs: paragraphs.length ? paragraphs : [NO_CONTENT_PLACEHOLDER] };
    }),
    sources: (input.sources ?? []).map(sourceToMemoSource),
  };
}

function safeFileName(title: string): string {
  const safe = title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${safe || 'hearing-brief'}.docx`;
}

@Injectable()
export class HearingBriefExportService {
  constructor(private readonly clientDocuments: ClientDocumentWriterService) {}

  async exportDocx(input: BriefExportInput): Promise<{ buffer: Buffer; fileName: string }> {
    const buffer = await renderMemoDocx(briefToMemoDocInput(input));
    return { buffer, fileName: safeFileName(input.title) };
  }

  async saveToClient(
    ctx: TenantContext,
    hearingId: string,
    input: BriefExportInput & { clientId: string },
  ): Promise<{ attachmentId: string; fileName: string }> {
    const { buffer, fileName } = await this.exportDocx(input);
    const saved = await this.clientDocuments.createAttachmentFromBuffer(ctx, {
      clientId: input.clientId,
      fileName,
      contentType: DOCX_MIME,
      buffer,
      source: 'legiwatch_hearing_brief',
      sourceEntityType: 'hearing_session',
      sourceEntityId: hearingId,
      // A retried/double-clicked save with byte-identical content reuses the
      // existing attachment instead of piling up duplicate copies; a genuinely
      // different (edited/regenerated) brief still files as a new document,
      // since the writer folds the buffer's own hash into the dedup key too.
      idempotencyKey: `legiwatch-hearing-brief:${hearingId}`,
    });
    return { attachmentId: saved.id, fileName: saved.fileName };
  }
}
