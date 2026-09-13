import { BadRequestException } from '@nestjs/common';
import {
  digest,
  escapeHtml,
  object,
  renderReport,
  text,
  type ReportDocument,
} from './report-domain.js';
export type SelectedRecordBrief = {
  eventId: string;
  briefId: string;
  contentHash: string;
  sourceHash: string;
  version: number;
  approvedAt: string;
};
export type IncludedRecordBrief = SelectedRecordBrief & {
  title: string;
  markdown: string;
  kind: 'record_brief' | 'record_correction';
  developmentKeys: string[];
};
export function selectedRecordBriefs(input: unknown): SelectedRecordBrief[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 5)
    throw new BadRequestException('SELECT_AT_MOST_FIVE_EXACT_RECORD_BRIEFS');
  const refs = input.map((value) => {
    const b = object(value);
    if (
      !/^[a-f0-9]{64}$/.test(String(b.contentHash)) ||
      !/^[a-f0-9]{64}$/.test(String(b.sourceHash)) ||
      !Number.isSafeInteger(b.version) ||
      Number(b.version) < 1 ||
      !Number.isFinite(Date.parse(String(b.approvedAt)))
    )
      throw new BadRequestException('EXACT_REVIEWED_RECORD_BRIEF_REFERENCE_REQUIRED');
    return {
      eventId: text(b.eventId, 200),
      briefId: text(b.briefId, 100),
      contentHash: String(b.contentHash),
      sourceHash: String(b.sourceHash),
      version: Number(b.version),
      approvedAt: String(b.approvedAt),
    };
  });
  if (new Set(refs.map((r) => r.briefId)).size !== refs.length)
    throw new BadRequestException('DUPLICATE_RECORD_BRIEF_SELECTION');
  return refs;
}
export const developmentKey = (billId: string, identity: string, hash: string) =>
  digest([billId, identity, hash]);
/** The saved run stays intact. Only repeated source developments in this exact
 * reviewed composition are omitted; client analysis and corrections remain. */
export function renderReportWithBriefs(doc: ReportDocument, briefs: IncludedRecordBrief[]) {
  if (!briefs.length) return renderReport(doc);
  const keys = new Set(briefs.flatMap((b) => b.developmentKeys)),
    keep = (billId: string, e: { sourceIdentity: string; revisionHash: string }) =>
      !keys.has(developmentKey(billId, e.sourceIdentity, e.revisionHash));
  const copy: ReportDocument = {
    ...doc,
    rows: doc.rows.map((r) => ({
      ...r,
      actions: r.actions.filter((e) => keep(r.id, e)),
      amendments: r.amendments.filter((e) => keep(r.id, e)),
    })),
    ...(doc.updates
      ? {
          updates: {
            ...doc.updates,
            records: doc.updates.records.filter((e) => keep(e.billId, e)),
          },
        }
      : {}),
  };
  const result = renderReport(copy),
    notice =
      'Repeated source developments are discussed once in the explicitly selected Capiro briefs below. The underlying bill report and every source version are preserved.';
  const body = briefs
    .map(
      (b) =>
        `${b.kind === 'record_correction' ? 'REVIEWED CORRECTION / FOLLOW-UP' : 'CAPIRO BRIEF BASED ON PUBLISHED RECORDS'}\nVersion ${b.version} · ${b.briefId} / ${b.contentHash}\nReviewed ${b.approvedAt}\n\n${b.markdown}`,
    )
    .join('\n\n');
  return {
    html: result.html.replace(
      '</body>',
      `<section><h2>Selected hearing briefs</h2><p>${escapeHtml(notice)}</p><pre style="white-space:pre-wrap">${escapeHtml(body)}</pre></section></body>`,
    ),
    text: result.text + '\n\n' + notice + '\n\n' + body,
  };
}
