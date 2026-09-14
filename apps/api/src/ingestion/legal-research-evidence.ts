import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { legalReferenceKey, floridaCitationOccurrences, type LegalReference } from '@capiro/shared';
import type { FlFarNoticeDetail } from '../external/state-register/fl-far.client.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function persistLegalReference(tx: Prisma.TransactionClient, ref: LegalReference) {
  const id = legalReferenceKey(ref);
  await tx.$executeRaw`INSERT INTO legal_reference(id,jurisdiction,code_kind,reference_kind,chapter,section,subdivisions,identity)
 VALUES(${id},${ref.jurisdiction},${ref.code},${ref.kind},${ref.chapter},${ref.section},${JSON.stringify(ref.subdivisions)}::jsonb,${JSON.stringify(ref)}::jsonb) ON CONFLICT DO NOTHING`;
  return id;
}
export async function persistNoticeEvidence(
  tx: Prisma.TransactionClient,
  detail: FlFarNoticeDetail,
) {
  const noticeId = `FL-${detail.noticeId}`,
    revision = hash([noticeId, detail.contentHash, detail.parserVersion]);
  const { originalHtml, ...payload } = detail;
  await tx.$executeRaw`INSERT INTO rule_notice_revision(id,notice_id,source_url,content_hash,parser_version,payload,original_html)
 VALUES(${revision},${noticeId},${`https://flrules.org/Gateway/View_notice.asp?id=${detail.noticeId}`},${detail.contentHash},${detail.parserVersion},${JSON.stringify(payload)}::jsonb,${originalHtml}) ON CONFLICT DO NOTHING`;
  for (const rule of detail.rules) {
    const id = await persistLegalReference(tx, {
      jurisdiction: 'FL',
      code: 'administrative_rule',
      kind: 'rule',
      chapter: null,
      section: rule.number,
      subdivisions: [],
    });
    await tx.$executeRaw`INSERT INTO rule_notice_reference(revision_id,reference_id,source_url) VALUES(${revision},${id},${rule.sourceUrl}) ON CONFLICT DO NOTHING`;
  }
  const dates = [
    ['comment_start', detail.commentStartDate, 'COMMENTS'],
    ['comment_end', detail.commentEndDate, 'COMMENTS'],
    ['filing', detail.filingDate, 'RULE FILE DATE'],
    ['effective', detail.effectiveDate, 'RULE EFFECTIVE DATE'],
  ] as const;
  for (const [kind, date, field] of dates)
    if (date) {
      const id = hash([revision, kind, date]);
      await tx.$executeRaw`INSERT INTO legal_published_date(id,notice_revision_id,kind,raw_wording,date_only,precision,basis,source_locator)
   VALUES(${id},${revision},${kind},${detail.rawDates[field] ?? date},${date}::date,'date','explicit',${`field:${field}`}) ON CONFLICT DO NOTHING`;
    }
  return revision;
}
export async function indexLegislativeReferences(
  tx: Prisma.TransactionClient,
  document: {
    id: string;
    billId: string;
    jurisdiction: string;
    sessionKey: string;
    revision: string;
    kind: string;
    sections: Array<{ locator: string; text: string }>;
  },
) {
  if (document.jurisdiction !== 'FL')
    return { occurrences: 0, unresolved: ['JURISDICTION_NOT_QUALIFIED'] };
  let count = 0;
  const unresolved: string[] = [];
  for (const section of document.sections) {
    const found = floridaCitationOccurrences(
      section.text,
      document.kind === 'amendment'
        ? 'amendment_text'
        : document.kind === 'text'
          ? 'bill_text'
          : 'analysis',
    );
    unresolved.push(...found.unresolved);
    for (const occurrence of found.occurrences) {
      const referenceId = await persistLegalReference(tx, occurrence.reference);
      const id = hash([
        document.id,
        document.revision,
        section.locator,
        occurrence.start,
        occurrence.end,
        referenceId,
        'fl-citation-v2',
      ]);
      await tx.$executeRaw`INSERT INTO legislative_legal_occurrence(id,document_id,bill_id,jurisdiction,session_key,document_revision,reference_id,locator,start_offset,end_offset,quote,relation,basis,parser_version)
    VALUES(${id},${document.id},${document.billId},${document.jurisdiction},${document.sessionKey},${document.revision},${referenceId},${section.locator},${occurrence.start},${occurrence.end},${occurrence.quote},${occurrence.relation},${occurrence.basis},'fl-citation-v2') ON CONFLICT DO NOTHING`;
      count++;
    }
  }
  return { occurrences: count, unresolved: [...new Set(unresolved)] };
}
