import { Injectable, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { FOLDER_SOURCE_SQL, type FolderSourceBill } from './folder-source-data.repository.js';
import { QUERY_LIMITS } from '../tracker/keywords/keyword-query.js';

export type KeywordField = 'title' | 'bill_text' | 'amendment_text';
export type KeywordScope = { jurisdiction: string; sessionKey: string; fields: KeywordField[] };
export type KeywordDocument = {
  id: string;
  billId: string;
  kind: KeywordField;
  revision: string;
  observationId: string;
  sourceUrl: string | null;
  extractorVersion: string | null;
  text: string | null;
  complete: boolean;
  reason: string | null;
};
export type KeywordSourceBill = {
  bill: FolderSourceBill;
  documents: KeywordDocument[];
  fingerprint: string;
  coverage: { complete: boolean; inspectedDocuments: number; missing: string[] };
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function keywordScope(input: unknown): KeywordScope {
  const b = input as Record<string, unknown>;
  if (
    !b ||
    !/^[A-Z]{2}$/.test(String(b.jurisdiction)) ||
    typeof b.sessionKey !== 'string' ||
    !b.sessionKey ||
    b.sessionKey.length > 60 ||
    !Array.isArray(b.fields) ||
    !b.fields.length ||
    b.fields.length > 3 ||
    b.fields.some((f) => !['title', 'bill_text', 'amendment_text'].includes(String(f)))
  )
    throw new BadRequestException('EXPLICIT_KEYWORD_SOURCE_SCOPE_REQUIRED');
  return {
    jurisdiction: b.jurisdiction as string,
    sessionKey: b.sessionKey,
    fields: [...new Set(b.fields)] as KeywordField[],
  };
}

@Injectable()
export class KeywordSourceRepository {
  constructor(readonly prisma: PrismaService) {}
  /** Statement-consistent, public-only scope fingerprint. Changing the corpus
   * holds a resumed scan, rather than skipping or replaying moving rows.
   */
  async boundary(scope: KeywordScope): Promise<string> {
    const [r] = await this.prisma.$queryRawUnsafe<Array<{ fingerprint: string }>>(
      `WITH bills AS (
      SELECT * FROM (${FOLDER_SOURCE_SQL}) b WHERE jurisdiction=$1 AND "sessionKey"=$2
    ) SELECT md5(coalesce((SELECT string_agg(id||':'||title, '|' ORDER BY id COLLATE "C") FROM bills),'')||':'||
      coalesce((SELECT string_agg(d.document_id||':'||d.observation_id, '|' ORDER BY d.document_id COLLATE "C")
      FROM legiwatch_keyword_document_source d JOIN bills b ON b.id=d.bill_id),'')||':'||
      coalesce((SELECT string_agg(c.bill_key||':'||c.source_identity||':'||c.state||':'||coalesce(c.revision_hash,''), '|' ORDER BY c.bill_key,c.source_identity)
      FROM state_bill_record_check c JOIN bills b ON b.id=c.bill_key WHERE c.kind='document'),'')) AS fingerprint`,
      scope.jurisdiction,
      scope.sessionKey,
    );
    return hash(JSON.stringify([scope, r!.fingerprint]));
  }
  async page(
    scope: KeywordScope,
    after: string | null = null,
    limit = 25,
  ): Promise<{ rows: KeywordSourceBill[]; next: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (after?.length ?? 0) > 250)
      throw new BadRequestException('INVALID_SOURCE_PAGE');
    const bills = await this.prisma.$queryRawUnsafe<FolderSourceBill[]>(
      `SELECT * FROM (${FOLDER_SOURCE_SQL}) b
      WHERE jurisdiction=$1 AND "sessionKey"=$2 AND ($3::text IS NULL OR id COLLATE "C">$3 COLLATE "C")
      ORDER BY id COLLATE "C" LIMIT $4`,
      scope.jurisdiction,
      scope.sessionKey,
      after,
      limit + 1,
    );
    return {
      rows: await this.forBills(scope, bills.slice(0, limit)),
      next: bills.length > limit ? bills[limit - 1]!.id : null,
    };
  }
  async bill(scope: KeywordScope, billId: string): Promise<KeywordSourceBill | null> {
    const bills = await this.prisma.$queryRawUnsafe<FolderSourceBill[]>(
      `SELECT * FROM (${FOLDER_SOURCE_SQL}) b WHERE jurisdiction=$1 AND "sessionKey"=$2 AND id=$3`,
      scope.jurisdiction,
      scope.sessionKey,
      billId,
    );
    return (await this.forBills(scope, bills))[0] ?? null;
  }
  async lockBill(tx: Prisma.TransactionClient, scope: KeywordScope, billId: string) {
    if (scope.jurisdiction === 'US')
      await tx.$queryRaw`SELECT id FROM congress_bill WHERE id=${billId} AND congress::text=${scope.sessionKey} FOR SHARE`;
    else
      await tx.$queryRaw`SELECT id FROM state_bill WHERE id=${billId} AND upper(state)=${scope.jurisdiction} AND session_key=${scope.sessionKey} FOR SHARE`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('legiwatch-published-record-commit-v1',0))`;
    return this.bill(scope, billId);
  }
  private async forBills(
    scope: KeywordScope,
    bills: FolderSourceBill[],
  ): Promise<KeywordSourceBill[]> {
    if (!bills.length) return [];
    const ids = bills.map((b) => b.id);
    type Row = {
      document_id: string;
      bill_id: string;
      source_identity: string;
      document_kind: string;
      revision_hash: string;
      observation_id: string;
      source_url: string | null;
      extractor_version: string | null;
      extraction_state: string;
      coverage: string;
      sections: unknown;
    };
    const rows = scope.fields.some((f) => f !== 'title')
      ? await this.prisma.$queryRawUnsafe<Row[]>(
          `SELECT document_id,bill_id,source_identity,document_kind,revision_hash,observation_id,source_url,extractor_version,extraction_state,coverage,
      CASE WHEN pg_column_size(sections)<4000000 THEN sections ELSE NULL END AS sections
      FROM legiwatch_keyword_document_source WHERE bill_id=ANY($1::text[]) ORDER BY bill_id,document_id LIMIT 1001`,
          ids,
        )
      : [];
    const checks = scope.fields.some((f) => f !== 'title')
      ? await this.prisma.$queryRawUnsafe<
          Array<{
            bill_key: string;
            source_identity: string;
            state: string;
            revision_hash: string | null;
          }>
        >(
          `SELECT bill_key,source_identity,state,revision_hash FROM state_bill_record_check WHERE bill_key=ANY($1::text[]) AND kind='document'`,
          ids,
        )
      : [];
    return bills.map((bill) => {
      const documents: KeywordDocument[] = [],
        missing: string[] = [];
      if (scope.fields.includes('title'))
        documents.push({
          id: `${bill.id}:title`,
          billId: bill.id,
          kind: 'title',
          revision: hash(bill.title),
          observationId: hash(bill.title),
          sourceUrl: bill.sourceUrl,
          extractorVersion: 'canonical-title-v1',
          text: bill.title,
          complete: true,
          reason: null,
        });
      for (const r of rows.filter((r) => r.bill_id === bill.id).slice(0, 1000)) {
        const kind =
          r.document_kind === 'amendment'
            ? 'amendment_text'
            : r.document_kind === 'text'
              ? 'bill_text'
              : null;
        if (!kind || !scope.fields.includes(kind)) continue;
        const sections = Array.isArray(r.sections)
          ? (r.sections as Array<{ text?: unknown; locator?: unknown }>)
          : [];
        // Character chunks are contiguous; PDF pages carry a whitespace boundary.
        const separator =
          r.extractor_version === 'utf8-normalized-character-locators-v1' ||
          r.extractor_version === 'govinfo-html-normalizer-locators-v1'
            ? ''
            : '\n';
        const valid = sections.length > 0 && sections.every((s) => typeof s.text === 'string');
        const joined = valid ? sections.map((s) => s.text as string).join(separator) : null;
        const text = joined !== null && joined.length <= QUERY_LIMITS.text ? joined : null;
        const complete =
          text !== null && r.coverage === 'complete_document' && r.extraction_state === 'extracted';
        documents.push({
          id: r.document_id,
          billId: bill.id,
          kind,
          revision: r.revision_hash,
          observationId: r.observation_id,
          sourceUrl: r.source_url,
          extractorVersion: r.extractor_version,
          text,
          complete,
          reason: complete ? null : 'DOCUMENT_TEXT_INCOMPLETE',
        });
      }
      for (const field of scope.fields)
        if (!documents.some((d) => d.kind === field)) missing.push(`${field}:not_indexed`);
      if (rows.length > 1000) missing.push('DOCUMENT_PAGE_BUDGET');
      for (const c of checks.filter((c) => c.bill_key === bill.id))
        if (
          c.state !== 'available' ||
          !rows.some(
            (r) =>
              r.bill_id === bill.id &&
              r.source_identity === c.source_identity &&
              r.revision_hash === c.revision_hash,
          )
        )
          missing.push(`source_check:${c.source_identity}:${c.state}`);
      // Retained documents alone cannot prove the provider supplied every bill
      // and amendment version. Keep full-corpus automation held until qualified.
      if (scope.fields.some((f) => f !== 'title'))
        missing.push('FULL_DOCUMENT_CORPUS_NOT_QUALIFIED');
      const fingerprint = hash(
        JSON.stringify({
          billId: bill.id,
          scope,
          documents: documents.map(({ text, ...d }) => d),
          missing,
        }),
      );
      return {
        bill,
        documents,
        fingerprint,
        coverage: {
          complete: !missing.length && documents.every((d) => d.complete),
          inspectedDocuments: documents.length,
          missing,
        },
      };
    });
  }
}
