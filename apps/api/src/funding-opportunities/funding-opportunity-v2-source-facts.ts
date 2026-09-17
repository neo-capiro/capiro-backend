import { Prisma } from '@prisma/client';
import type { OpportunitySourceV2 } from '@capiro/shared';

export type SourceFactRecord = Record<string, unknown>;

export interface FundingOpportunityV2SourceFactSnapshot {
  sourceFacts: SourceFactRecord;
  raw: SourceFactRecord;
  sourceUpdatedAt: string | null;
  sourceUpdatedPrecision: 'date' | 'timestamp' | 'raw' | null;
  sourceUpdatedRaw: string | null;
  ingestedAt: string | null;
  providerRecordId: string | null;
  changeNotes: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactDescription: string | null;
  documentUrl: string | null;
  techDocsUrl: string | null;
  topicUrl: string | null;
  officialSolicitationUrl: string | null;
  applicationUrls: string[];
  applicationEmails: string[];
}

type SystemPrisma = {
  withSystem<T>(
    fn: (tx: { $queryRaw: <R>(query: Prisma.Sql) => Promise<R> }) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
};

type FactRow = {
  raw?: unknown;
  snapshot?: unknown;
  source_updated_at?: Date | string | null;
  source_updated_raw?: string | null;
  source_updated_precision?: 'date' | 'timestamp' | 'raw' | null;
  ingested_at?: Date | string | null;
  provider_record_id?: string | null;
  external_id?: string | null;
  change_notes?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_description?: string | null;
  document_url?: string | null;
  tech_docs_url?: string | null;
  topic_url?: string | null;
  official_solicitation_url?: string | null;
  application_urls?: string[] | null;
  application_emails?: string[] | null;
  opportunity_number?: string | null;

};

function object(value: unknown): SourceFactRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SourceFactRecord : {};
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}
function time(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return string(value);
}

function sourceQuery(source: OpportunitySourceV2, id: string): Prisma.Sql {
  switch (source) {
    case 'grants_gov':
      return Prisma.sql`SELECT coalesce(raw, '{}'::jsonb) AS raw, opportunity_number, last_updated_at AS source_updated_at,
        raw #>> '{synopsis,lastUpdatedDate}' AS source_updated_raw,
        'raw'::text AS source_updated_precision, detail_synced_at AS ingested_at,
        NULL::text AS provider_record_id, NULL::text AS change_notes,
        NULLIF(raw #>> '{synopsis,agencyContactName}', '') AS contact_name,
        NULLIF(raw #>> '{synopsis,agencyContactEmail}', '') AS contact_email,
        NULLIF(raw #>> '{synopsis,agencyContactPhone}', '') AS contact_phone,
        NULLIF(raw #>> '{synopsis,agencyContactDesc}', '') AS contact_description,
        NULL::text AS document_url, NULL::text AS tech_docs_url,
        NULL::text AS topic_url, NULL::text AS official_solicitation_url,
        ARRAY[]::text[] AS application_urls, ARRAY[]::text[] AS application_emails
        FROM federal_grant WHERE id = ${id} LIMIT 1`;
    case 'sam_gov':
      return Prisma.sql`SELECT raw_jsonb AS raw, NULL::timestamptz AS source_updated_at,
        raw_jsonb->>'lastModifiedDate' AS source_updated_raw, 'raw'::text AS source_updated_precision,
        last_synced_at AS ingested_at, notice_id AS provider_record_id, NULL::text AS change_notes,
        poc_name AS contact_name, poc_email AS contact_email, NULL::text AS contact_phone,
        NULL::text AS contact_description, NULL::text AS document_url, NULL::text AS tech_docs_url,
        NULL::text AS topic_url, NULL::text AS official_solicitation_url,
        ARRAY[]::text[] AS application_urls, ARRAY[]::text[] AS application_emails
        FROM sam_opportunity WHERE id = ${id}::uuid LIMIT 1`;
    case 'agency_forecast':
      return Prisma.sql`SELECT snapshot, external_id, provider_modified_at AS source_updated_at,
        provider_modified_at::text AS source_updated_raw, 'timestamp'::text AS source_updated_precision,
        last_synced_at AS ingested_at, external_id AS provider_record_id, NULL::text AS change_notes,
        primary_contact_name AS contact_name, primary_contact_email AS contact_email,
        primary_contact_phone AS contact_phone, primary_contact_title AS contact_description,
        NULL::text AS document_url, NULL::text AS tech_docs_url, NULL::text AS topic_url,
        NULL::text AS official_solicitation_url, ARRAY[]::text[] AS application_urls,
        ARRAY[]::text[] AS application_emails
        FROM tango_procurement_forecast WHERE tango_forecast_id = ${id} LIMIT 1`;
    case 'dibbs':
      return Prisma.sql`SELECT '{}'::jsonb AS raw, NULL::timestamptz AS source_updated_at,
        NULL::text AS source_updated_raw, NULL::text AS source_updated_precision,
        last_synced_at AS ingested_at, NULL::text AS provider_record_id, NULL::text AS change_notes,
        NULL::text AS contact_name, NULL::text AS contact_email, NULL::text AS contact_phone,
        NULL::text AS contact_description, document_url, tech_docs_url, NULL::text AS topic_url,
        NULL::text AS official_solicitation_url, ARRAY[]::text[] AS application_urls,
        ARRAY[]::text[] AS application_emails
        FROM tango_dibbs_solicitation WHERE tango_dibbs_id = ${id} LIMIT 1`;
    case 'sbir_sttr':
      return Prisma.sql`SELECT jsonb_build_object('provenance', 'tango_sbir_topic') AS raw, NULL::timestamptz AS source_updated_at,
        NULL::text AS source_updated_raw, NULL::text AS source_updated_precision,
        last_synced_at AS ingested_at, NULL::text AS provider_record_id, NULL::text AS change_notes,
        NULL::text AS contact_name, NULL::text AS contact_email, NULL::text AS contact_phone,
        NULL::text AS contact_description, NULL::text AS document_url, NULL::text AS tech_docs_url,
        topic_url, official_solicitation_url, ARRAY[]::text[] AS application_urls,
        ARRAY[]::text[] AS application_emails
        FROM tango_sbir_topic WHERE tango_sbir_id = ${id}
        UNION ALL
        SELECT jsonb_build_object('provenance', 'tango_sbir_solicitation'), NULL::timestamptz, NULL::text, NULL::text, last_synced_at,
          NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
          NULL::text, NULL::text, NULL::text, NULL::text,
          ARRAY[]::text[], ARRAY[]::text[]
        FROM tango_sbir_solicitation WHERE tango_sbir_id = ${id} LIMIT 1`;
    case 'ca_portal':
      return Prisma.sql`SELECT raw_jsonb AS raw, last_updated_calendar_date::text AS source_updated_raw,
        'date'::text AS source_updated_precision, NULL::timestamptz AS source_updated_at,
        ingested_at, NULL::text AS provider_record_id, change_notes,
        NULL::text AS contact_name, NULL::text AS contact_email, NULL::text AS contact_phone,
        contact_info AS contact_description, NULL::text AS document_url, NULL::text AS tech_docs_url,
        NULL::text AS topic_url, NULL::text AS official_solicitation_url,
        electronic_submission_urls AS application_urls, electronic_submission_emails AS application_emails
        FROM california_grant_opportunity WHERE portal_id = ${id} LIMIT 1`;
  }
}

/** Reads only the current cached source row. It never performs a public fetch. */
export async function readFundingOpportunityV2SourceFacts(
  prisma: SystemPrisma,
  source: OpportunitySourceV2,
  sourceRecordId: string,
  baseFacts: SourceFactRecord,
): Promise<FundingOpportunityV2SourceFactSnapshot> {
  const rows = await prisma.withSystem(
    (tx) => tx.$queryRaw<FactRow[]>(sourceQuery(source, sourceRecordId)),
    { timeoutMs: 10_000 },
  );
  const row = rows[0];
  const raw = object(row?.raw ?? row?.snapshot);
  const nested = object(raw.synopsis ?? raw.forecast);
  const sourceFacts: SourceFactRecord = { ...baseFacts, ...raw, ...nested, ...(row?.opportunity_number ? { opportunityNumber: row.opportunity_number } : {}), ...(row?.external_id ? { externalId: row.external_id } : {}) };
  const sourceUpdatedRaw = string(nested.lastUpdatedDate) ?? string(row?.source_updated_raw);
  const sourceUpdatedAt = time(row?.source_updated_at);
  const ingestedAt = time(row?.ingested_at) ?? string(baseFacts.ingestedAt);
  const applicationUrls = [...new Set([...(row?.application_urls ?? []), ...list(sourceFacts.electronicSubmissionUrls)])];
  const applicationEmails = [...new Set([...(row?.application_emails ?? []), ...list(sourceFacts.electronicSubmissionEmails)])];
  return {
    sourceFacts, raw, sourceUpdatedAt,
    sourceUpdatedPrecision: row?.source_updated_precision ?? (sourceUpdatedRaw ? 'raw' : null),
    sourceUpdatedRaw, ingestedAt,
    providerRecordId: string(row?.provider_record_id) ?? string(baseFacts.noticeId),
    changeNotes: string(row?.change_notes) ?? string(baseFacts.changeNotes),
    contactName: string(row?.contact_name) ?? string(sourceFacts.agencyContactName) ?? string(sourceFacts.primaryContactName),
    contactEmail: string(row?.contact_email) ?? string(sourceFacts.agencyContactEmail) ?? string(sourceFacts.primaryContactEmail),
    contactPhone: string(row?.contact_phone) ?? string(sourceFacts.agencyPhone) ?? string(sourceFacts.primaryContactPhone),
    contactDescription: string(row?.contact_description) ?? string(sourceFacts.agencyContactDesc) ?? string(sourceFacts.primaryContactTitle),
    documentUrl: string(row?.document_url), techDocsUrl: string(row?.tech_docs_url),
    topicUrl: string(row?.topic_url), officialSolicitationUrl: string(row?.official_solicitation_url),
    applicationUrls, applicationEmails,
  };
}

export function asSourceFactRecord(value: unknown): SourceFactRecord {
  return object(value);
}

export function asSourceString(value: unknown): string | null {
  return string(value);
}
