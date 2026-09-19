import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import {
  object,
  type ReportBill,
  type PublishedEvent,
  type Committee,
} from '../tracker/reports/report-domain.js';

/** Florida's canonical provider uses H/S; the legislature also displays HB/SB.
 * This is a lookup alias only: never rename canonical IDs or coerce proposals.
 * Punctuation and whitespace inside the prefix are ignored ("H.R. 177",
 * "H B 2", "s. 1932" all normalize), matching how users type bill numbers.
 */
export function normalizeBillNumber(value: string, jurisdiction?: string): string | null {
  const match = /^([A-Z][A-Z.\s]*)0*(\d+)$/i.exec(value.trim());
  if (!match) return null;
  let prefix = match[1]!.replaceAll(/[.\s]/g, '').toUpperCase();
  if (jurisdiction === 'FL' && (prefix === 'H' || prefix === 'S')) prefix += 'B';
  return `${prefix}${BigInt(match[2]!).toString()}`;
}

// Keep the SQL lookup identical to normalizeBillNumber's jurisdiction-specific alias.
export const FOLDER_NUMBER_SQL = `(CASE
  WHEN b.jurisdiction = 'FL' AND regexp_replace(upper(b.number), '[^A-Z]', '', 'g') IN ('H','S')
    THEN regexp_replace(upper(b.number), '[^A-Z]', '', 'g') || 'B'
  ELSE regexp_replace(upper(b.number), '[^A-Z]', '', 'g') END
  || coalesce(nullif(regexp_replace(b.number, '[^0-9]', '', 'g'), ''), '0')::numeric::text)`;

export interface FolderSourceBill {
  id: string;
  number: string;
  title: string;
  sponsor: string | null;
  jurisdiction: string;
  sessionKey: string;
  status: string | null;
  latestAction: string | null;
  latestActionAt: Date | null;
  sourceUrl: string | null;
  chamber?: string | null;
  summary?: string | null;
  classifications?: string[];
  subjects?: string[];
  currentCommittee?: string | null;
}

/**
 * Origin-chamber projection for the state branch of FOLDER_SOURCE_SQL.
 *
 * StateBill.chamber is the bill's CURRENT chamber (LegiScan current_body), not
 * its origin — a Senate bill that crossed to the House is stored chamber='H'.
 * Origin is instead read from the identifier's canonical chamber prefix family
 * (S/SB → Senate, H/HB → House, A/AB → Assembly), but ONLY behind the same
 * anchored full-number guard the number parser uses. Both the guard and the
 * prefix read apply the SAME normalized trim (btrim + upper): the guard
 * '^\s*[A-Z]+\s*0*\d+$' tolerates leading whitespace, so the prefix substring
 * must read from btrim(identifier) — a bare '^[A-Z]+' substring on untrimmed
 * text finds no prefix on ' SB 9' and wrongly falls through to the
 * current-chamber fallback. Malformed/non-numeric identifiers never match the
 * guard and fall back to the existing current-chamber mapping. Federal bills
 * already use origin_chamber directly; current-chamber consumers are untouched.
 */
export const FOLDER_ORIGIN_SQL = `CASE
  WHEN upper(sb.identifier) ~ '^\\s*[A-Z]+\\s*0*\\d+$' AND substring(upper(btrim(sb.identifier)) from '^[A-Z]+') ~ '^S' THEN 'upper'
  WHEN upper(sb.identifier) ~ '^\\s*[A-Z]+\\s*0*\\d+$' AND substring(upper(btrim(sb.identifier)) from '^[A-Z]+') ~ '^[HA]' THEN 'lower'
  ELSE CASE upper(sb.chamber) WHEN 'H' THEN 'lower' WHEN 'HOUSE' THEN 'lower' WHEN 'A' THEN 'lower' WHEN 'ASSEMBLY' THEN 'lower' WHEN 'LOWER' THEN 'lower' WHEN 'S' THEN 'upper' WHEN 'SENATE' THEN 'upper' WHEN 'UPPER' THEN 'upper' ELSE NULL END
  END`;

/** Global canonical read projection; no legislative copies or source mutations. */
export const FOLDER_SOURCE_SQL = `
  SELECT id, identifier AS number, title, sponsor_name AS sponsor,
    upper(state) AS jurisdiction, session_key AS "sessionKey", status,
    latest_action_text AS "latestAction", latest_action_date AS "latestActionAt",
    coalesce(state_url, url) AS "sourceUrl",
    ${FOLDER_ORIGIN_SQL} AS chamber,
    description AS summary, classification AS classifications, subjects,
    coalesce(
      (SELECT c.name FROM state_committee c WHERE c.id = sb.current_committee_id),
      report_source_facts->'currentCommittee'->>'name'
    ) AS "currentCommittee"
  FROM state_bill sb
  UNION ALL
  SELECT id, upper(bill_type) || ' ' || bill_number::text AS number, title,
    sponsor_name AS sponsor, 'US' AS jurisdiction, congress::text AS "sessionKey", status,
    latest_action_text AS "latestAction", latest_action_date AS "latestActionAt", url AS "sourceUrl",
    CASE origin_chamber WHEN 'house' THEN 'lower' WHEN 'senate' THEN 'upper' ELSE origin_chamber END AS chamber,
    NULL AS summary, ARRAY[]::text[] AS classifications, subjects,
    NULL AS "currentCommittee"
  FROM congress_bill`;

@Injectable()
export class FolderSourceDataRepository {
  constructor(private readonly prisma: PrismaService) {}
  async staffDestination(tenantId: string, userId: string) {
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{ email: string | null }>
        >`SELECT u.email FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id=${tenantId}::uuid AND u.clerk_user_id=${userId} AND m.status::text='active' LIMIT 1`,
    );
    return rows[0] ?? null;
  }
  /** Batch global facts for operational reports. Private folder context never
   * crosses this repository. Optional coverage remains unknown until ingestion.
   */
  async reportBills(ids: string[]): Promise<ReportBill[]> {
    if (!ids.length) return [];
    const [base, extra, records, legacy, related] = await Promise.all([
      this.bills(ids),
      this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          summary: string | null;
          checked: Date | null;
          attempted: Date | null;
          checkStatus: string | null;
          facts: unknown;
        }>
      >(
        `SELECT id,description AS summary,source_checked_at AS checked,source_check_attempted_at AS attempted,source_check_status AS "checkStatus",report_source_facts AS facts FROM state_bill WHERE id=ANY($1::text[])`,
        ids,
      ),
      this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          billId: string;
          kind: string;
          identity: string;
          hash: string;
          date: string | null;
          order: number;
          observed: Date;
          evidence: unknown;
        }>
      >(
        `SELECT id,bill_key AS "billId",kind,source_identity AS identity,revision_hash AS hash,event_date AS date,source_order AS "order",first_observed_at AS observed,evidence FROM state_bill_published_record WHERE bill_key=ANY($1::text[]) AND kind IN ('action','amendment') ORDER BY first_observed_at,id`,
        ids,
      ),
      this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          billId: string;
          date: Date;
          text: string;
          order: number;
          observed: Date;
        }>
      >(
        `SELECT id,bill_key AS "billId",date,text,order_key AS "order",first_seen_at AS observed FROM state_bill_action WHERE bill_key=ANY($1::text[]) ORDER BY date,order_key,id`,
        ids,
      ),
      this.prisma.$queryRawUnsafe<
        Array<{
          billId: string;
          id: string;
          number: string;
          title: string;
          sourceUrl: string | null;
          providerId: number;
          actions: unknown;
        }>
      >(
        `SELECT l.bill_key AS "billId",b.id,b.identifier AS number,b.title,coalesce(b.state_url,b.url) AS "sourceUrl",l.legiscan_related_bill_id AS "providerId",
        coalesce((SELECT jsonb_agg(jsonb_build_object('key',a.id,'date',to_char(a.date,'YYYY-MM-DD'),'text',a.text,'order',a.order_key)) FROM state_bill_action a WHERE a.bill_key=b.id),'[]'::jsonb) AS actions
        FROM state_bill_link l JOIN state_bill b ON b.legiscan_bill_id=l.legiscan_related_bill_id WHERE l.bill_key=ANY($1::text[])`,
        ids,
      ),
    ]);
    return base.map((b) => {
      const x = extra.find((x) => x.id === b.id),
        facts = object(x?.facts),
        coverage = object(facts.coverage);
      const normalized = records
        .filter((r) => r.billId === b.id)
        .map((r) => {
          const ev = object(r.evidence);
          return {
            key: r.id,
            kind: r.kind,
            sourceIdentity: r.identity,
            revisionHash: r.hash,
            date: r.date,
            notificationEligible: ev.changeKind !== 'interpretation_revision',
            text: String(ev.text ?? ''),
            order: r.order,
            observedAt: r.observed.toISOString(),
            url: typeof ev.url === 'string' ? ev.url : null,
            ...(r.kind === 'amendment'
              ? {
                  adopted:
                    ev.adopted === true
                      ? true
                      : ev.interpretationVersion === 'legiscan-amendment-v2' && ev.rawAdopted === 0
                        ? false
                        : null,
                }
              : {}),
          };
        });
      const events: PublishedEvent[] =
        coverage.actions === true
          ? normalized
          : [
              ...normalized.filter((e) => e.kind !== 'action'),
              ...legacy
                .filter((a) => a.billId === b.id)
                .map((a) => ({
                  key: a.id,
                  kind: 'action',
                  sourceIdentity: a.id,
                  revisionHash: '',
                  date: a.date.toISOString().slice(0, 10),
                  text: a.text,
                  order: a.order,
                  observedAt: a.observed.toISOString(),
                  url: b.sourceUrl,
                })),
            ];
      const committees = (Array.isArray(facts.committees) ? facts.committees : []).map(
        (c) => object(c) as unknown as Committee,
      );
      const current = object(facts.currentCommittee);
      if (current.name && !committees.some((c) => c.id === current.id))
        committees.push(current as unknown as Committee);
      const relations = (Array.isArray(facts.relations) ? facts.relations : []).map((raw) => {
        const relation = object(raw),
          detail = related.find((r) => r.billId === b.id && r.providerId === relation.providerId);
        return {
          id: detail?.id ?? null,
          number: detail?.number ?? String(relation.number ?? ''),
          title: detail?.title ?? null,
          category: String(relation.category ?? 'Related'),
          sourceUrl: detail?.sourceUrl ?? null,
          actions: (Array.isArray(detail?.actions) ? detail.actions : []).map(
            (a) =>
              ({
                ...object(a),
                kind: 'action',
                observedAt: '',
                sourceIdentity: '',
                revisionHash: '',
                url: detail?.sourceUrl ?? null,
              }) as PublishedEvent,
          ),
        };
      });
      return {
        ...b,
        summary: x?.summary ?? null,
        sourceCheckedAt: x?.checked?.toISOString() ?? null,
        sourceCheckAttemptedAt: x?.attempted?.toISOString() ?? null,
        sourceCheckStatus: x?.checkStatus ?? null,
        coverage: {
          actions: coverage.actions === true,
          committees: coverage.committees === true,
          relations: coverage.relations === true,
          amendments: coverage.amendments === true,
        },
        committees,
        relations,
        events,
      };
    });
  }
  async reportCoverage(ids: string[]) {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe<
      Array<{ id: string; checked: Date | null; status: string | null }>
    >(
      'SELECT id,source_checked_at AS checked,source_check_status AS status FROM state_bill WHERE id=ANY($1::text[])',
      ids,
    );
  }
  async bills(ids: string[]): Promise<FolderSourceBill[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM (${FOLDER_SOURCE_SQL}) b WHERE id = ANY($1::text[])`,
      ids,
    );
  }
  async sessions(jurisdiction: string): Promise<Array<{ key: string; label: string }>> {
    if (jurisdiction === 'US')
      return this.prisma.$queryRawUnsafe(
        `SELECT DISTINCT congress::text AS key, congress::text || 'th Congress' AS label FROM congress_bill ORDER BY key DESC`,
      );
    return this.prisma.$queryRawUnsafe(
      `SELECT session_key AS key, coalesce(max(nullif(session,session_key)),session_key) AS label
       FROM state_bill WHERE upper(state) = $1 GROUP BY session_key ORDER BY key DESC`,
      jurisdiction,
    );
  }
  /**
   * Jurisdictions + sessions derived from what is actually ingested — never a
   * static UI allowlist — so a newly ingested state or special session becomes
   * searchable without a code change. Global public corpus only.
   */
  async corpusMetadata(): Promise<{
    jurisdictions: Array<{ key: string; count: number }>;
    sessions: Array<{ jurisdiction: string; key: string; label: string; count: number }>;
  }> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ jurisdiction: string; sessionKey: string; label: string; count: number }>
    >(
      `SELECT * FROM (
         SELECT upper(state) AS jurisdiction, session_key AS "sessionKey",
           coalesce(max(nullif(session,session_key)),session_key) AS label,
           count(*)::int AS count
         FROM state_bill GROUP BY 1, 2
         UNION ALL
         SELECT 'US', congress::text, congress::text || 'th Congress', count(*)::int
         FROM congress_bill GROUP BY congress
       ) s ORDER BY jurisdiction, "sessionKey" DESC`,
    );
    const jurisdictions = new Map<string, number>();
    for (const row of rows)
      jurisdictions.set(row.jurisdiction, (jurisdictions.get(row.jurisdiction) ?? 0) + row.count);
    return {
      jurisdictions: [...jurisdictions.entries()]
        .sort(([a], [b]) => (a === 'US' ? -1 : b === 'US' ? 1 : a.localeCompare(b)))
        .map(([key, count]) => ({ key, count })),
      sessions: rows.map((r) => ({
        jurisdiction: r.jurisdiction,
        key: r.sessionKey,
        label: r.label,
        count: r.count,
      })),
    };
  }
  async resolve(
    jurisdiction: string,
    sessionKey: string,
    numbers: string[],
  ): Promise<FolderSourceBill[]> {
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM (${FOLDER_SOURCE_SQL}) b
      WHERE jurisdiction = $1 AND "sessionKey" = $2
      AND ${FOLDER_NUMBER_SQL} = ANY($3::text[])`,
      jurisdiction,
      sessionKey,
      numbers,
    );
  }
  async activeMember(
    tenantId: string,
    clerkUserId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const read = async (tx: Prisma.TransactionClient) =>
      (
        await tx.$queryRawUnsafe<Array<{ ok: number }>>(
          `SELECT 1 AS ok FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1::uuid AND u.clerk_user_id = $2 AND tm.status::text = 'active' LIMIT 1`,
          tenantId,
          clerkUserId,
        )
      ).length === 1;
    return transaction ? read(transaction) : this.prisma.withSystem(read);
  }
  async members(tenantId: string) {
    return this.prisma.withSystem(
      (tx) => tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT u.clerk_user_id AS id,coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),'Workspace member') AS name
      FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
      WHERE tm.tenant_id=${tenantId}::uuid AND tm.status::text='active' ORDER BY name,u.clerk_user_id`,
    );
  }
}
