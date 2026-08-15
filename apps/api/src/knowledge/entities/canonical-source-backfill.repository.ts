import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  ClientIdentitySource,
  ClientPersonIdentitySource,
  ConfirmedClientMappingIdentitySource,
  EngagementContactIdentitySource,
} from './canonical-source-adapter.types.js';

interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  website: string | null;
  uei: string | null;
  cage_code: string | null;
  lda_client_ids: number[] | null;
}

interface ClientPersonRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  email: string | null;
  title: string | null;
}

interface EngagementContactRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  full_name: string | null;
  email: string | null;
  organization: string | null;
  title: string | null;
  directory_entry_id: string | null;
  acquisition_personnel_id: string | null;
}

interface ConfirmedMappingRow {
  id: string;
  tenant_id: string;
  client_id: string;
  client_name: string;
  client_website: string | null;
  client_uei: string | null;
  client_cage_code: string | null;
  source: 'contracting' | 'lda';
  external_id: string;
  external_name: string;
  confirmed: boolean;
  review_status: string;
  match_basis: string | null;
  match_tier: number | null;
  contractor_name: string | null;
  contractor_uei: string | null;
  contractor_recipient_id: string | null;
  lda_name: string | null;
}

/** Keyset-paginated reads of identity-bearing source records. */
@Injectable()
export class CanonicalSourceBackfillRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listClients(
    tenantId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ClientIdentitySource[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ClientRow[]>`
        SELECT
          id,
          tenant_id,
          name,
          website,
          uei,
          cage_code,
          lda_client_ids
        FROM clients
        WHERE tenant_id = ${tenantId}::uuid
          AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
          AND COALESCE(upper(profile_status), 'ACTIVE') <> 'DELETED'
        ORDER BY id
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        website: row.website,
        uei: row.uei,
        cageCode: row.cage_code,
        ldaClientIds: row.lda_client_ids ?? [],
      }));
    });
  }

  async listClientPeople(
    tenantId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ClientPersonIdentitySource[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ClientPersonRow[]>`
        SELECT id, tenant_id, client_id, name, email::text AS email, title
        FROM client_people
        WHERE tenant_id = ${tenantId}::uuid
          AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
        ORDER BY id
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        clientId: row.client_id,
        name: row.name,
        email: row.email,
        title: row.title,
      }));
    });
  }

  async listEngagementContacts(
    tenantId: string,
    afterId: string | null,
    limit: number,
  ): Promise<EngagementContactIdentitySource[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<EngagementContactRow[]>`
        SELECT
          id,
          tenant_id,
          client_id,
          full_name,
          email::text AS email,
          organization,
          title,
          directory_entry_id,
          acquisition_personnel_id
        FROM engagement_contacts
        WHERE tenant_id = ${tenantId}::uuid
          AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
        ORDER BY id
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        clientId: row.client_id,
        fullName: row.full_name,
        email: row.email,
        organization: row.organization,
        title: row.title,
        directoryEntryId: row.directory_entry_id,
        acquisitionPersonnelId: row.acquisition_personnel_id,
      }));
    });
  }

  async listConfirmedClientMappings(
    tenantId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ConfirmedClientMappingIdentitySource[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ConfirmedMappingRow[]>`
        SELECT
          mapping.id,
          mapping.tenant_id,
          mapping.client_id,
          client.name AS client_name,
          client.website AS client_website,
          client.uei AS client_uei,
          client.cage_code AS client_cage_code,
          mapping.source,
          mapping.external_id,
          mapping.external_name,
          mapping.confirmed,
          mapping.review_status,
          mapping.match_basis,
          mapping.match_tier,
          contractor.name AS contractor_name,
          contractor.uei AS contractor_uei,
          contractor.recipient_id AS contractor_recipient_id,
          lda.name AS lda_name
        FROM client_intel_mapping AS mapping
        JOIN clients AS client
          ON client.id = mapping.client_id
         AND client.tenant_id = mapping.tenant_id
        LEFT JOIN federal_contractor AS contractor
          ON mapping.source = 'contracting'
         AND contractor.id::text = mapping.external_id
        LEFT JOIN lda_client AS lda
          ON mapping.source = 'lda'
         AND lda.id::text = mapping.external_id
        WHERE mapping.tenant_id = ${tenantId}::uuid
          AND (${afterId}::uuid IS NULL OR mapping.id > ${afterId}::uuid)
          AND mapping.source IN ('contracting', 'lda')
          AND mapping.confirmed = true
          AND mapping.review_status = 'confirmed'
          AND COALESCE(upper(client.profile_status), 'ACTIVE') <> 'DELETED'
        ORDER BY mapping.id
        LIMIT ${limit}
      `;

      return rows.map(mapConfirmedMapping);
    });
  }
}

function mapConfirmedMapping(
  row: ConfirmedMappingRow,
): ConfirmedClientMappingIdentitySource {
  if (row.source === 'contracting') {
    const publicName = row.contractor_name ?? row.external_name;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      clientId: row.client_id,
      clientName: row.client_name,
      clientWebsite: row.client_website,
      clientUei: row.client_uei,
      clientCageCode: row.client_cage_code,
      source: 'contracting',
      externalId: row.external_id,
      externalName: publicName,
      confirmed: row.confirmed,
      reviewStatus: row.review_status,
      matchBasis: row.match_basis,
      matchTier: row.match_tier,
      publicIdentifiers: [
        {
          type: 'federal_contractor_id',
          value: row.external_id,
          sourceType: 'federal_contractor',
          sourceId: row.external_id,
          confidence: 1,
        },
        ...(row.contractor_uei
          ? [
              {
                type: 'uei',
                value: row.contractor_uei,
                sourceType: 'federal_contractor',
                sourceId: row.external_id,
                confidence: 1,
              },
            ]
          : []),
        ...(row.contractor_recipient_id
          ? [
              {
                type: 'usaspending_recipient_id',
                value: row.contractor_recipient_id,
                sourceType: 'federal_contractor',
                sourceId: row.external_id,
                confidence: 1,
              },
            ]
          : []),
      ],
      publicAliases: [
        {
          value: publicName,
          sourceType: 'federal_contractor',
          sourceId: row.external_id,
          confidence: 1,
        },
      ],
    };
  }

  const publicName = row.lda_name ?? row.external_name;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientWebsite: row.client_website,
    clientUei: row.client_uei,
    clientCageCode: row.client_cage_code,
    source: 'lda',
    externalId: row.external_id,
    externalName: publicName,
    confirmed: row.confirmed,
    reviewStatus: row.review_status,
    matchBasis: row.match_basis,
    matchTier: row.match_tier,
    publicIdentifiers: [
      {
        type: 'lda_client_id',
        value: row.external_id,
        sourceType: 'lda_client',
        sourceId: row.external_id,
        confidence: 1,
      },
    ],
    publicAliases: [
      {
        value: publicName,
        sourceType: 'lda_client',
        sourceId: row.external_id,
        confidence: 1,
      },
    ],
  };
}
