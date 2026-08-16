import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  CanonicalPublicReferenceRecord,
  CanonicalPublicReferenceSource,
} from './canonical-public-reference-backfill.types.js';

interface PublicReferenceRow {
  cursor_key: string;
  source_id: string;
  canonical_name: string;
  identifier_type: string;
  identifier_value: string;
  aliases: unknown;
  metadata: unknown;
  observed_at: Date;
}

const MAX_BATCH_SIZE = 500;

/**
 * Read-only, keyset-paginated adapters over authoritative public Capiro source
 * tables. These queries produce registration candidates only; they never write
 * source tables and never use fuzzy/name-only matching to establish identity.
 */
@Injectable()
export class CanonicalPublicReferenceBackfillRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listBatch(
    source: CanonicalPublicReferenceSource,
    cursor: string | null,
    limit: number,
  ): Promise<CanonicalPublicReferenceRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw new BadRequestException(`limit must be an integer between 1 and ${MAX_BATCH_SIZE}`);
    }

    return this.prisma.withSystem(async (tx) => {
      const rows = await this.querySource(tx, source, cursor, limit);
      return rows.map((row) => mapRow(source, row));
    });
  }

  private async querySource(
    tx: Prisma.TransactionClient,
    source: CanonicalPublicReferenceSource,
    cursor: string | null,
    limit: number,
  ): Promise<PublicReferenceRow[]> {
    switch (source) {
      case 'federal_contractors':
        return tx.$queryRaw<PublicReferenceRow[]>`
          SELECT
            fc.id::text AS cursor_key,
            fc.id::text AS source_id,
            fc.name AS canonical_name,
            CASE
              WHEN upper(btrim(COALESCE(fc.uei, ''))) ~ '^[A-Z0-9]{12}$' THEN 'uei'
              ELSE 'usaspending_recipient_id'
            END AS identifier_type,
            CASE
              WHEN upper(btrim(COALESCE(fc.uei, ''))) ~ '^[A-Z0-9]{12}$'
                THEN upper(btrim(fc.uei))
              ELSE btrim(fc.recipient_id)
            END AS identifier_value,
            CASE
              WHEN nullif(btrim(COALESCE(fc.slug, '')), '') IS NULL THEN '[]'::jsonb
              ELSE jsonb_build_array(fc.slug)
            END AS aliases,
            jsonb_strip_nulls(jsonb_build_object(
              'category', fc.category,
              'recipientId', fc.recipient_id,
              'sourceTable', 'federal_contractor'
            )) AS metadata,
            fc.last_synced_at AS observed_at
          FROM federal_contractor fc
          WHERE (${cursor}::text IS NULL OR fc.id::text > ${cursor}::text)
            AND (
              upper(btrim(COALESCE(fc.uei, ''))) ~ '^[A-Z0-9]{12}$'
              OR nullif(btrim(COALESCE(fc.recipient_id, '')), '') IS NOT NULL
            )
          ORDER BY fc.id::text ASC
          LIMIT ${limit}
        `;

      case 'congress_members':
        return tx.$queryRaw<PublicReferenceRow[]>`
          SELECT
            cm.bioguide_id AS cursor_key,
            cm.bioguide_id AS source_id,
            cm.full_name AS canonical_name,
            'congress_id'::text AS identifier_type,
            cm.bioguide_id AS identifier_value,
            '[]'::jsonb AS aliases,
            jsonb_strip_nulls(jsonb_build_object(
              'chamber', cm.chamber,
              'state', cm.state,
              'district', cm.district,
              'party', cm.party,
              'lisId', cm.lis_id,
              'isCurrent', cm.is_current,
              'sourceTable', 'congress_member'
            )) AS metadata,
            cm.last_synced_at AS observed_at
          FROM congress_member cm
          WHERE (${cursor}::text IS NULL OR cm.bioguide_id > ${cursor}::text)
          ORDER BY cm.bioguide_id ASC
          LIMIT ${limit}
        `;

      case 'congress_committees':
        return tx.$queryRaw<PublicReferenceRow[]>`
          SELECT
            cc.system_code AS cursor_key,
            cc.system_code AS source_id,
            cc.name AS canonical_name,
            'committee_id'::text AS identifier_type,
            cc.system_code AS identifier_value,
            '[]'::jsonb AS aliases,
            jsonb_strip_nulls(jsonb_build_object(
              'chamber', cc.chamber,
              'thomasId', cc.thomas_id,
              'parentSystemCode', cc.parent_system_code,
              'isCurrent', cc.is_current,
              'sourceTable', 'congress_committee'
            )) AS metadata,
            cc.last_synced_at AS observed_at
          FROM congress_committee cc
          WHERE (${cursor}::text IS NULL OR cc.system_code > ${cursor}::text)
          ORDER BY cc.system_code ASC
          LIMIT ${limit}
        `;

      case 'acquisition_personnel':
        return tx.$queryRaw<PublicReferenceRow[]>`
          SELECT
            ap.id::text AS cursor_key,
            ap.id::text AS source_id,
            ap.full_name AS canonical_name,
            'directory_person_id'::text AS identifier_type,
            ap.id::text AS identifier_value,
            '[]'::jsonb AS aliases,
            jsonb_strip_nulls(jsonb_build_object(
              'service', ap.service,
              'organization', ap.organization,
              'title', ap.title,
              'role', ap.role,
              'programOfRecord', ap.program_of_record,
              'status', ap.status,
              'sourceTable', 'acquisition_personnel'
            )) AS metadata,
            ap.last_seen_at AS observed_at
          FROM acquisition_personnel ap
          WHERE (${cursor}::text IS NULL OR ap.id::text > ${cursor}::text)
            AND ap.superseded_at IS NULL
            AND ap.status = 'active'
          ORDER BY ap.id::text ASC
          LIMIT ${limit}
        `;

      case 'program_elements':
        return tx.$queryRaw<PublicReferenceRow[]>`
          SELECT
            pe.pe_code AS cursor_key,
            pe.pe_code AS source_id,
            pe.title AS canonical_name,
            'program_element_code'::text AS identifier_type,
            pe.pe_code AS identifier_value,
            CASE
              WHEN nullif(btrim(COALESCE(pe.program_of_record, '')), '') IS NULL THEN '[]'::jsonb
              ELSE jsonb_build_array(pe.program_of_record)
            END AS aliases,
            jsonb_strip_nulls(jsonb_build_object(
              'service', pe.service,
              'serviceCode', pe.service_code,
              'appropriationType', pe.appropriation_type,
              'budgetActivity', pe.budget_activity,
              'status', pe.status,
              'sourceTable', 'program_element'
            )) AS metadata,
            pe.last_synced_at AS observed_at
          FROM program_element pe
          WHERE (${cursor}::text IS NULL OR pe.pe_code > ${cursor}::text)
            AND pe.retired_at IS NULL
          ORDER BY pe.pe_code ASC
          LIMIT ${limit}
        `;

      case 'lda_clients':
        return tx.$queryRaw<PublicReferenceRow[]>`
          SELECT
            lpad(lc.id::text, 12, '0') AS cursor_key,
            lc.id::text AS source_id,
            lc.name AS canonical_name,
            'lda_client_id'::text AS identifier_type,
            lc.id::text AS identifier_value,
            '[]'::jsonb AS aliases,
            jsonb_strip_nulls(jsonb_build_object(
              'state', lc.state,
              'country', lc.country,
              'latestFilingYear', lc.latest_filing_year,
              'sourceTable', 'lda_client'
            )) AS metadata,
            lc.last_synced_at AS observed_at
          FROM lda_client lc
          WHERE (
            ${cursor}::text IS NULL
            OR lpad(lc.id::text, 12, '0') > ${cursor}::text
          )
          ORDER BY lpad(lc.id::text, 12, '0') ASC
          LIMIT ${limit}
        `;

      case 'sec_companies':
        return tx.$queryRaw<PublicReferenceRow[]>`
          WITH latest_company AS (
            SELECT DISTINCT ON (regexp_replace(cik, '\\D', '', 'g'))
              lpad(regexp_replace(cik, '\\D', '', 'g'), 10, '0') AS normalized_cik,
              company_name,
              state_of_incorp,
              sic,
              filing_date,
              synced_at
            FROM sec_filing
            WHERE regexp_replace(cik, '\\D', '', 'g') ~ '^[0-9]{1,10}$'
            ORDER BY
              regexp_replace(cik, '\\D', '', 'g'),
              filing_date DESC,
              accession_number DESC
          )
          SELECT
            normalized_cik AS cursor_key,
            normalized_cik AS source_id,
            company_name AS canonical_name,
            'cik'::text AS identifier_type,
            normalized_cik AS identifier_value,
            '[]'::jsonb AS aliases,
            jsonb_strip_nulls(jsonb_build_object(
              'stateOfIncorporation', state_of_incorp,
              'sic', sic,
              'latestFilingDate', filing_date,
              'sourceTable', 'sec_filing'
            )) AS metadata,
            synced_at AS observed_at
          FROM latest_company
          WHERE (${cursor}::text IS NULL OR normalized_cik > ${cursor}::text)
          ORDER BY normalized_cik ASC
          LIMIT ${limit}
        `;
    }
  }
}

function mapRow(
  source: CanonicalPublicReferenceSource,
  row: PublicReferenceRow,
): CanonicalPublicReferenceRecord {
  const aliases = Array.isArray(row.aliases)
    ? row.aliases.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];

  return {
    cursorKey: row.cursor_key,
    source,
    sourceId: row.source_id,
    entityType: entityTypeForSource(source),
    canonicalName: row.canonical_name,
    identifiers: [{ type: row.identifier_type, value: row.identifier_value }],
    aliases,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as CanonicalPublicReferenceRecord['metadata'])
        : {},
    observedAt: row.observed_at,
  };
}

function entityTypeForSource(source: CanonicalPublicReferenceSource): string {
  switch (source) {
    case 'federal_contractors':
    case 'lda_clients':
    case 'sec_companies':
      return 'organization';
    case 'congress_members':
    case 'acquisition_personnel':
      return 'person';
    case 'congress_committees':
      return 'committee';
    case 'program_elements':
      return 'program_element';
  }
}
