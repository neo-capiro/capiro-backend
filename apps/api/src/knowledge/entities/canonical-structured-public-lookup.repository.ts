import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface StructuredIdentifierLookup {
  type: string;
  normalizedValue: string;
}

export interface StructuredPublicIdentityRecord {
  canonicalName: string;
  entityType: string;
  sourceType: string;
  sourceId: string;
  identifierType: string;
  identifierValue: string;
  aliases: string[];
  observedAt: Date;
}

interface LookupRow {
  canonical_name: string;
  source_id: string;
  aliases: unknown;
  observed_at: Date;
}

/**
 * Exact, read-only lookups over authoritative public Capiro source tables.
 * This repository never creates canonical identity and never performs fuzzy or
 * model matching. Registration remains owned by the canonical registration
 * boundary after resolver policy approves a unique authoritative candidate.
 */
@Injectable()
export class CanonicalStructuredPublicLookupRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findDirectoryGovernment(
    identifiers: readonly StructuredIdentifierLookup[],
  ): Promise<StructuredPublicIdentityRecord[]> {
    return this.prisma.withSystem(async (tx) => {
      const output: StructuredPublicIdentityRecord[] = [];
      for (const identifier of identifiers) {
        switch (identifier.type) {
          case 'congress_id':
          case 'bioguide_id':
            output.push(
              ...mapRows(
                await tx.$queryRaw<LookupRow[]>`
                  SELECT full_name AS canonical_name,
                         bioguide_id AS source_id,
                         '[]'::jsonb AS aliases,
                         COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
                  FROM congress_member
                  WHERE upper(replace(bioguide_id, '-', '')) = ${identifier.normalizedValue}
                  LIMIT 2
                `,
                'person',
                'congress_member',
                identifier.type,
                identifier.normalizedValue,
              ),
            );
            break;
          case 'lis_id':
            output.push(
              ...mapRows(
                await tx.$queryRaw<LookupRow[]>`
                  SELECT full_name AS canonical_name,
                         bioguide_id AS source_id,
                         '[]'::jsonb AS aliases,
                         COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
                  FROM congress_member
                  WHERE lis_id IS NOT NULL
                    AND upper(replace(lis_id, '-', '')) = ${identifier.normalizedValue}
                  LIMIT 2
                `,
                'person',
                'congress_member',
                'lis_id',
                identifier.normalizedValue,
              ),
            );
            break;
          case 'committee_id':
            output.push(
              ...mapRows(
                await tx.$queryRaw<LookupRow[]>`
                  SELECT name AS canonical_name,
                         system_code AS source_id,
                         '[]'::jsonb AS aliases,
                         COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
                  FROM congress_committee
                  WHERE upper(replace(system_code, '-', '')) = ${identifier.normalizedValue}
                  LIMIT 2
                `,
                'committee',
                'congress_committee',
                'committee_id',
                identifier.normalizedValue,
              ),
            );
            break;
          case 'directory_person_id':
          case 'acquisition_personnel_id':
            output.push(
              ...mapRows(
                await tx.$queryRaw<LookupRow[]>`
                  SELECT full_name AS canonical_name,
                         id::text AS source_id,
                         '[]'::jsonb AS aliases,
                         COALESCE(last_seen_at, CURRENT_TIMESTAMP) AS observed_at
                  FROM acquisition_personnel
                  WHERE upper(replace(id::text, '-', '')) = ${identifier.normalizedValue}
                    AND superseded_at IS NULL
                    AND status = 'active'
                  LIMIT 2
                `,
                'person',
                'capiro_directory',
                'directory_person_id',
                identifier.normalizedValue,
              ),
            );
            break;
          case 'program_element_code':
            output.push(
              ...mapRows(
                await tx.$queryRaw<LookupRow[]>`
                  SELECT title AS canonical_name,
                         pe_code AS source_id,
                         CASE
                           WHEN nullif(btrim(COALESCE(program_of_record, '')), '') IS NULL
                             THEN '[]'::jsonb
                           ELSE jsonb_build_array(program_of_record)
                         END AS aliases,
                         COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
                  FROM program_element
                  WHERE upper(replace(replace(pe_code, '-', ''), ' ', '')) = ${identifier.normalizedValue}
                    AND retired_at IS NULL
                  LIMIT 2
                `,
                'program_element',
                'program_element',
                'program_element_code',
                identifier.normalizedValue,
              ),
            );
            break;
        }
      }
      return dedupe(output);
    });
  }

  async findSamUei(
    identifiers: readonly StructuredIdentifierLookup[],
  ): Promise<StructuredPublicIdentityRecord[]> {
    return this.prisma.withSystem(async (tx) => {
      const output: StructuredPublicIdentityRecord[] = [];
      for (const identifier of identifiers) {
        if (identifier.type === 'uei') {
          output.push(
            ...mapRows(
              await tx.$queryRaw<LookupRow[]>`
                SELECT name AS canonical_name,
                       id::text AS source_id,
                       CASE
                         WHEN nullif(btrim(COALESCE(slug, '')), '') IS NULL THEN '[]'::jsonb
                         ELSE jsonb_build_array(slug)
                       END AS aliases,
                       COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
                FROM federal_contractor
                WHERE upper(replace(replace(btrim(COALESCE(uei, '')), '-', ''), ' ', '')) = ${identifier.normalizedValue}
                LIMIT 2
              `,
              'organization',
              'federal_contractor',
              'uei',
              identifier.normalizedValue,
            ),
          );
        } else if (identifier.type === 'federal_contractor_id') {
          output.push(
            ...mapRows(
              await tx.$queryRaw<LookupRow[]>`
                SELECT name AS canonical_name,
                       id::text AS source_id,
                       CASE
                         WHEN nullif(btrim(COALESCE(slug, '')), '') IS NULL THEN '[]'::jsonb
                         ELSE jsonb_build_array(slug)
                       END AS aliases,
                       COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
                FROM federal_contractor
                WHERE lower(id::text) = ${identifier.normalizedValue}
                LIMIT 2
              `,
              'organization',
              'federal_contractor',
              'federal_contractor_id',
              identifier.normalizedValue,
            ),
          );
        }
      }
      return dedupe(output);
    });
  }

  async findUsaSpending(
    identifiers: readonly StructuredIdentifierLookup[],
  ): Promise<StructuredPublicIdentityRecord[]> {
    return this.prisma.withSystem(async (tx) => {
      const output: StructuredPublicIdentityRecord[] = [];
      for (const identifier of identifiers) {
        if (identifier.type !== 'usaspending_recipient_id') continue;
        output.push(
          ...mapRows(
            await tx.$queryRaw<LookupRow[]>`
              SELECT name AS canonical_name,
                     id::text AS source_id,
                     CASE
                       WHEN nullif(btrim(COALESCE(slug, '')), '') IS NULL THEN '[]'::jsonb
                       ELSE jsonb_build_array(slug)
                     END AS aliases,
                     COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
              FROM federal_contractor
              WHERE upper(replace(replace(btrim(COALESCE(recipient_id, '')), '-', ''), ' ', '')) = ${identifier.normalizedValue}
              LIMIT 2
            `,
            'organization',
            'federal_contractor',
            'usaspending_recipient_id',
            identifier.normalizedValue,
          ),
        );
      }
      return dedupe(output);
    });
  }

  async findLda(
    identifiers: readonly StructuredIdentifierLookup[],
  ): Promise<StructuredPublicIdentityRecord[]> {
    return this.prisma.withSystem(async (tx) => {
      const output: StructuredPublicIdentityRecord[] = [];
      for (const identifier of identifiers) {
        if (identifier.type !== 'lda_client_id') continue;
        output.push(
          ...mapRows(
            await tx.$queryRaw<LookupRow[]>`
              SELECT name AS canonical_name,
                     id::text AS source_id,
                     '[]'::jsonb AS aliases,
                     COALESCE(last_synced_at, CURRENT_TIMESTAMP) AS observed_at
              FROM lda_client
              WHERE id::text = ${identifier.normalizedValue}
              LIMIT 2
            `,
            'organization',
            'lda_client',
            'lda_client_id',
            identifier.normalizedValue,
          ),
        );
      }
      return dedupe(output);
    });
  }

  async findSec(
    identifiers: readonly StructuredIdentifierLookup[],
  ): Promise<StructuredPublicIdentityRecord[]> {
    return this.prisma.withSystem(async (tx) => {
      const output: StructuredPublicIdentityRecord[] = [];
      for (const identifier of identifiers) {
        if (identifier.type !== 'cik') continue;
        output.push(
          ...mapRows(
            await tx.$queryRaw<LookupRow[]>`
              SELECT company_name AS canonical_name,
                     lpad(regexp_replace(cik, '\\D', '', 'g'), 10, '0') AS source_id,
                     '[]'::jsonb AS aliases,
                     COALESCE(synced_at, CURRENT_TIMESTAMP) AS observed_at
              FROM sec_filing
              WHERE lpad(regexp_replace(cik, '\\D', '', 'g'), 10, '0') = ${identifier.normalizedValue}
              ORDER BY filing_date DESC, accession_number DESC
              LIMIT 1
            `,
            'organization',
            'sec_filing',
            'cik',
            identifier.normalizedValue,
          ),
        );
      }
      return dedupe(output);
    });
  }
}

function mapRows(
  rows: readonly LookupRow[],
  entityType: string,
  sourceType: string,
  identifierType: string,
  identifierValue: string,
): StructuredPublicIdentityRecord[] {
  return rows
    .filter((row) => row.canonical_name?.trim() && row.source_id?.trim())
    .map((row) => ({
      canonicalName: row.canonical_name.trim(),
      entityType,
      sourceType,
      sourceId: row.source_id,
      identifierType,
      identifierValue,
      aliases: Array.isArray(row.aliases)
        ? row.aliases.filter(
            (value): value is string => typeof value === 'string' && value.trim().length > 0,
          )
        : [],
      observedAt: row.observed_at,
    }));
}

function dedupe(
  records: readonly StructuredPublicIdentityRecord[],
): StructuredPublicIdentityRecord[] {
  const output = new Map<string, StructuredPublicIdentityRecord>();
  for (const record of records) {
    output.set(`${record.sourceType}:${record.sourceId}:${record.identifierType}`, record);
  }
  return [...output.values()];
}
