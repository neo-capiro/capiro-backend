import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { object } from '../tracker/reports/report-domain.js';
import {
  sourcePassage,
  type PublishedRecord,
  type RecordSourceSelection,
} from '../hearing/published-record-domain.js';
export type RecordEvent = {
  id: string;
  title: string;
  jurisdiction: string | null;
  session: string | null;
  date: string;
  body: string | null;
  revision: number;
};
@Injectable()
export class HearingRecordsRepository {
  constructor(readonly prisma: PrismaService) {}
  async event(id: string) {
    const rows = await this.prisma.$queryRawUnsafe<RecordEvent[]>(
      `SELECT id,title,geographic_jurisdiction AS jurisdiction,
      legislative_session AS session,to_char(date,'YYYY-MM-DD') AS date,coalesce(state_committee_id,committee_code) AS body,
      calendar_revision AS revision FROM committee_hearing WHERE id=$1 AND visibility='public'`,
      id,
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }
  async page(
    eventId: string,
    offset = 0,
    limit = 50,
    full = false,
  ): Promise<{ event: RecordEvent; records: PublishedRecord[]; next: number | null }> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('INVALID_RECORD_PAGE');
    const event = await this.event(eventId);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        billId: string | null;
        kind: string;
        hash: string;
        identity: string;
        date: string | null;
        observed: Date;
        evidence: unknown;
        explicit: boolean;
      }>
    >(
      `
      SELECT r.id::text,r.bill_key AS "billId",r.kind,r.revision_hash AS hash,r.source_identity AS identity,r.event_date AS date,r.first_observed_at AS observed,
        (r.evidence - 'contentSnapshotBase64' - 'raw' ${full ? '' : "- 'sections'"}) || jsonb_build_object('sourceObservationId',o.observation_id,'sourceLastChangedAt',o.observed_at,'currentSourceVersion',coalesce(o.state_record_id=r.id,NOT EXISTS(SELECT 1 FROM state_bill_published_record later WHERE later.bill_key=r.bill_key AND later.kind=r.kind AND later.source_identity=r.source_identity AND (later.first_observed_at,later.id)>(r.first_observed_at,r.id)))) AS evidence,(r.evidence->>'eventId'=$1) AS explicit
      FROM state_bill_published_record r LEFT JOIN published_record_source_current o ON o.source_key='state:'||r.bill_key||':'||r.kind||':'||r.source_identity JOIN state_bill b ON b.id=r.bill_key
      WHERE b.state=$2 AND b.session_key=$3 AND EXISTS (SELECT 1 FROM legislative_agenda_item a
        WHERE a.hearing_id=$1 AND a.state_bill_key=b.id AND a.active)
      UNION ALL SELECT r.id::text,NULL,'official_transcript',r.extraction_hash,r.package_id,r.published_date,r.observed_at,
        jsonb_build_object('provider','GovInfo','publisher','GPO / GovInfo','url',r.source_url,'parserVersion',r.parser_version,
        'contentHash',r.content_hash,'metadata',r.metadata,'title',r.metadata->>'title','documentClass',r.metadata->>'documentClass','sourceObservationId',o.observation_id,'sourceLastChangedAt',o.observed_at,'currentSourceVersion',coalesce(o.official_revision_id=r.id,NOT EXISTS(SELECT 1 FROM official_hearing_transcript_revision later WHERE later.package_id=r.package_id AND (later.observed_at,later.id)>(r.observed_at,r.id)))${full ? ",'text',r.extracted_text" : ''}),true
      FROM official_hearing_transcript_revision r LEFT JOIN published_record_source_current o ON o.source_key='govinfo:'||r.package_id JOIN official_hearing_transcript_event e ON e.revision_id=r.id
      WHERE e.hearing_id=$1 ORDER BY observed,id LIMIT $4 OFFSET $5`,
      eventId,
      event.jurisdiction,
      event.session,
      limit + 1,
      offset,
    );
    return {
      event,
      records: rows
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          billId: r.billId,
          kind: r.kind,
          hash: r.hash,
          identity: r.identity,
          date: r.date,
          observedAt: r.observed.toISOString(),
          evidence: object(r.evidence),
          association: r.explicit ? 'explicit_event' : 'bill_context_only',
        })),
      next: rows.length > limit ? offset + limit : null,
    };
  }
  async record(eventId: string, id: string) {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await this.page(eventId, offset, 100, true),
        record = page.records.find((r) => r.id === id);
      if (record) return record;
      offset = page.next;
    }
    throw new NotFoundException('RECORD_VERSION_UNAVAILABLE');
  }
  async snapshot(eventId: string, selection: RecordSourceSelection[] = []) {
    const all: PublishedRecord[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await this.page(eventId, offset, 100, true);
      for (const record of page.records) {
        const chosen = selection.find((s) => s.identity === record.identity);
        if (selection.length && !chosen) continue;
        if (chosen?.locators) {
          const selectedPassages: Record<string, string> = {},
            missing = [];
          for (const locator of chosen.locators) {
            const passage = sourcePassage(record, locator);
            if (passage !== null) selectedPassages[locator] = passage;
            else missing.push(locator);
          }
          const { text, sections, members, ...metadata } = record.evidence;
          all.push({
            ...record,
            evidence: {
              ...metadata,
              selectedPassages,
              selectedLocators: chosen.locators,
              missingSelectedLocators: missing,
              coverage: 'explicit_selected_passages_only',
            },
          });
        } else all.push(record);
      }
      offset = page.next;
      if (all.length > 2000) throw new BadRequestException('NARROW_RECORD_SCOPE_REQUIRED');
    }
    // Never silently call a tail selection complete. The bound is an actionable refusal.
    if (JSON.stringify(all).length > 2_000_000)
      throw new BadRequestException('RECORD_SNAPSHOT_REQUIRES_DOCUMENT_CHUNK_SELECTION');
    return all;
  }
  async checks(eventId: string) {
    const checks = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT b.id AS "billId",b.source_check_status AS state,
      b.source_checked_at AS "checkedAt",b.source_check_attempted_at AS "attemptedAt",b.report_source_facts AS coverage,
      coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM state_bill_record_check c WHERE c.bill_key=b.id),'[]') AS "recordChecks"
      FROM state_bill b WHERE EXISTS(SELECT 1 FROM legislative_agenda_item a WHERE a.hearing_id=$1 AND a.active AND a.state_bill_key=b.id)`,
      eventId,
    );
    const event = await this.event(eventId);
    if (!event.jurisdiction || event.jurisdiction === 'US') {
      const packages = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT DISTINCT r.package_id AS "packageId",c.checked_at AS "checkedAt",c.source_modified_at AS "sourceModifiedAt",
      coalesce(c.state,'pending') AS state,jsonb_build_object('officialTranscript','linked_package_only','minutes','not_covered','votes','not_covered','stateRecords','not_covered') AS coverage
      FROM official_hearing_transcript_revision r JOIN official_hearing_transcript_event e ON e.revision_id=r.id LEFT JOIN official_hearing_transcript_check c ON c.package_id=r.package_id WHERE e.hearing_id=$1`,
        eventId,
      );
      checks.push(
        ...(packages.length
          ? packages
          : [
              {
                state: 'pending',
                checkedAt: null,
                coverage: {
                  officialTranscript: 'no_qualified_package',
                  minutes: 'not_covered',
                  votes: 'not_covered',
                  stateRecords: 'not_covered',
                },
              },
            ]),
      );
    }
    return checks;
  }
}
