import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  normalizeDomain,
  normalizeEntityIdentifier,
  normalizeEntityText,
} from '../knowledge/entities/entity-normalization.js';
import type {
  EntityIdentifierInput,
  EntityResolutionCandidate,
} from '../knowledge/entities/entity-resolution.types.js';
import { UniversalEntityResolutionService } from '../knowledge/entities/universal-entity-resolution.service.js';
import type { KnowledgeJsonObject } from '../knowledge/knowledge.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ExactLexicalQuery,
  RetrievalDomain,
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
} from './retrieval-v2.types.js';

const MAX_EXACT_MATCHES = 500;

export type NormalizedExactLexicalQuery =
  | { kind: 'canonical_name'; value: string; normalizedText: string }
  | { kind: 'domain'; value: string; normalizedIdentifier: string }
  | { kind: 'uei'; value: string; normalizedIdentifier: string }
  | { kind: 'cage'; value: string; normalizedIdentifier: string }
  | { kind: 'cik'; value: string; normalizedIdentifier: string }
  | { kind: 'contract_id'; value: string; normalizedIdentifier: string }
  | {
      kind: 'bill_id';
      value: string;
      canonicalBillId?: string;
      billType: string;
      billNumber: string;
      congress?: number;
    }
  | { kind: 'pe_code'; value: string; normalizedIdentifier: string }
  | { kind: 'program_name'; value: string; normalizedText: string }
  | { kind: 'appropriation_account'; value: string; normalizedText: string };

interface PublicRow {
  record_id: string;
  payload: unknown;
  updated_at: Date | null;
}

function jsonObject(value: unknown): KnowledgeJsonObject {
  return JSON.parse(JSON.stringify(value)) as KnowledgeJsonObject;
}

/**
 * Knowledge Plane Phase 11 deterministic exact/lexical rail.
 *
 * This is deliberately part of Retrieval V2. It creates no search table,
 * feature-specific dictionary, model call, or alternate RAG stack. Tenant CRM
 * data is read through the same tenant/ethical-wall boundary, public facts stay
 * in their authoritative source tables, and canonical identity lookup delegates
 * to the existing read-only UniversalEntityResolutionService.preview().
 */
@Injectable()
export class ExactLexicalRetrievalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entityResolver: UniversalEntityResolutionService,
  ) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievalSourceResult[]> {
    if (!request.exactLexical) {
      throw new BadRequestException('Exact lexical retrieval intent is required.');
    }
    if (request.queryClass !== 'lookup') {
      throw new BadRequestException('Exact lexical retrieval requires queryClass=lookup.');
    }

    const exact = normalizeExactLexicalQuery(request.exactLexical);
    const domains = [...new Set(request.requestedDomains)];
    return Promise.all(domains.map((domain) => this.retrieveDomain(domain, exact, request)));
  }

  private retrieveDomain(
    domain: RetrievalDomain,
    exact: NormalizedExactLexicalQuery,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    switch (domain) {
      case 'clients':
        return this.retrieveClients(exact, request);
      case 'institutional_knowledge':
        return this.retrieveCanonicalIdentity(exact, request);
      case 'program_elements':
        return this.retrieveProgramElements(exact, request);
      case 'legiwatch_bills':
        return this.retrieveBills(exact, request);
      case 'contracts_opportunities':
        return this.retrieveContractOpportunities(exact, request);
      case 'federal_awards':
        return this.retrieveFederalAwards(exact, request);
      default:
        return Promise.resolve(
          this.unsupported(domain, request, `exact_kind_${exact.kind}_not_supported_for_domain`),
        );
    }
  }

  private async retrieveClients(
    exact: NormalizedExactLexicalQuery,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    const supportedKinds = new Set([
      'canonical_name',
      'domain',
      'uei',
      'cage',
      'appropriation_account',
      'pe_code',
    ]);
    if (!supportedKinds.has(exact.kind)) {
      return this.unsupported('clients', request, `exact_kind_${exact.kind}_not_supported_for_clients`);
    }

    const requestedClientIds = [...new Set(request.caller.clientIds ?? [])];
    return this.prisma.withTenant(request.caller.tenantId, async (tx) => {
      if (requestedClientIds.length > 0) {
        const authorized = await tx.client.findMany({
          where: {
            id: { in: requestedClientIds },
            OR: clientWallVisibility(request.caller.userId),
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        if (authorized.length !== requestedClientIds.length) {
          return this.unauthorized(
            'clients',
            requestedClientIds.length,
            authorized.length,
            'requested_client_scope_not_fully_authorized',
          );
        }
      }

      if (exact.kind === 'appropriation_account' || exact.kind === 'pe_code') {
        return this.retrieveClientCapabilities(tx, exact, request, requestedClientIds);
      }

      const candidates = await tx.client.findMany({
        where: {
          ...(requestedClientIds.length > 0 ? { id: { in: requestedClientIds } } : {}),
          OR: clientWallVisibility(request.caller.userId),
          ...clientExactWhere(exact),
        },
        select: {
          id: true,
          name: true,
          website: true,
          uei: true,
          cageCode: true,
          status: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
        take: MAX_EXACT_MATCHES + 1,
      });

      // Website is not stored as a normalized domain column, so the DB narrows
      // candidates by contains and the shared domain normalizer performs the
      // final equality check. No guessed subdomain/root-domain broadening.
      const exactCandidates =
        exact.kind === 'domain'
          ? candidates.filter((client) => {
              if (!client.website) return false;
              try {
                return normalizeDomain(client.website) === exact.normalizedIdentifier;
              } catch {
                return false;
              }
            })
          : candidates;

      return this.boundedResult(
        'clients',
        exactCandidates.map((client) => ({
          domain: 'clients',
          recordId: client.id,
          updatedAt: client.updatedAt,
          payload: jsonObject({
            id: client.id,
            name: client.name,
            website: client.website,
            uei: client.uei,
            cageCode: client.cageCode,
            status: client.status,
            exactMatchKind: exact.kind,
          }),
          provenance: {
            sourceType: 'clients',
            sourceId: client.id,
            matchKind: exact.kind,
          },
        })),
        requestedClientIds.length,
        requestedClientIds.length,
      );
    });
  }

  private async retrieveClientCapabilities(
    tx: Prisma.TransactionClient,
    exact: Extract<NormalizedExactLexicalQuery, { kind: 'appropriation_account' | 'pe_code' }>,
    request: RetrievalRequest,
    requestedClientIds: string[],
  ): Promise<RetrievalSourceResult> {
    let visibleClientIds = requestedClientIds;
    if (visibleClientIds.length === 0) {
      const visible = await tx.client.findMany({
        where: { OR: clientWallVisibility(request.caller.userId) },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      visibleClientIds = visible.map((row) => row.id);
    }

    if (visibleClientIds.length === 0) {
      return this.complete('clients', [], 0, requestedClientIds.length, 0);
    }

    const capabilities = await tx.clientCapability.findMany({
      where: {
        tenantId: request.caller.tenantId,
        clientId: { in: visibleClientIds },
        ...(exact.kind === 'appropriation_account'
          ? { appropriationAccount: { equals: exact.value, mode: 'insensitive' } }
          : {
              OR: [
                { peNumber: exact.normalizedIdentifier },
                { peNumbers: { has: exact.normalizedIdentifier } },
              ],
            }),
      },
      select: {
        id: true,
        clientId: true,
        name: true,
        appropriationAccount: true,
        peNumber: true,
        peNumbers: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
      take: MAX_EXACT_MATCHES + 1,
    });

    return this.boundedResult(
      'clients',
      capabilities.map((capability) => ({
        domain: 'clients',
        recordId: `capability:${capability.id}`,
        updatedAt: capability.updatedAt,
        payload: jsonObject({
          capabilityId: capability.id,
          clientId: capability.clientId,
          name: capability.name,
          appropriationAccount: capability.appropriationAccount,
          peNumber: capability.peNumber,
          peNumbers: capability.peNumbers,
          exactMatchKind: exact.kind,
        }),
        provenance: {
          sourceType: 'client_capabilities',
          sourceId: capability.id,
          matchKind: exact.kind,
        },
      })),
      requestedClientIds.length,
      visibleClientIds.length,
    );
  }

  private async retrieveCanonicalIdentity(
    exact: NormalizedExactLexicalQuery,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    const input = canonicalResolverInput(exact);
    if (!input) {
      return this.unsupported(
        'institutional_knowledge',
        request,
        `exact_kind_${exact.kind}_not_supported_by_canonical_identity`,
      );
    }

    const preview = await this.entityResolver.preview(request.caller.tenantId, {
      query: input.query,
      identifiers: input.identifiers,
      entityTypeHint: input.entityTypeHint,
      maxCandidates: 25,
    });
    const candidates = dedupeCanonicalCandidates(preview.candidates);
    const records: RetrievalRecord[] = candidates.map((candidate) => ({
      domain: 'institutional_knowledge',
      recordId: candidate.entity.id,
      canonicalEntityIds: [candidate.entity.id],
      updatedAt: candidate.entity.updatedAt,
      payload: jsonObject({
        canonicalEntityId: candidate.entity.id,
        canonicalName: candidate.entity.canonicalName,
        entityType: candidate.entity.entityType,
        identityScope: candidate.entity.identityScope,
        resolutionStatus: preview.status,
        resolutionMethod: candidate.resolutionMethod,
        confidence: candidate.confidence,
        exactMatchKind: exact.kind,
      }),
      provenance: jsonObject({ matches: candidate.provenance }),
    }));

    // Ambiguity is an exact-search result, not a source-coverage failure.
    return this.complete('institutional_knowledge', records, records.length, 0, 0);
  }

  private async retrieveProgramElements(
    exact: NormalizedExactLexicalQuery,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    if (!['pe_code', 'program_name', 'canonical_name'].includes(exact.kind)) {
      return this.unsupported(
        'program_elements',
        request,
        `exact_kind_${exact.kind}_not_supported_for_program_elements`,
      );
    }

    if (exact.kind === 'pe_code') {
      const rows = await this.prisma.programElement.findMany({
        where: { peCode: exact.normalizedIdentifier, retiredAt: null },
        select: {
          peCode: true,
          title: true,
          service: true,
          programOfRecord: true,
          appropriationType: true,
          lastSyncedAt: true,
        },
        take: 2,
      });
      return this.complete(
        'program_elements',
        rows.map((row) => ({
          domain: 'program_elements',
          recordId: row.peCode,
          updatedAt: row.lastSyncedAt,
          payload: jsonObject({
            peCode: row.peCode,
            title: row.title,
            service: row.service,
            programOfRecord: row.programOfRecord,
            appropriationType: row.appropriationType,
            exactMatchKind: exact.kind,
          }),
          provenance: { sourceType: 'program_element', sourceId: row.peCode },
        })),
        rows.length,
        0,
        0,
      );
    }

    const aliasKey = normalizeProgramAlias(exact.value);
    const [canonicalRows, aliasRows] = await Promise.all([
      this.prisma.program.findMany({
        where: { status: 'active', canonicalName: { equals: exact.value, mode: 'insensitive' } },
        select: {
          id: true,
          canonicalName: true,
          component: true,
          mdapCode: true,
          updatedAt: true,
        },
        take: MAX_EXACT_MATCHES + 1,
      }),
      this.prisma.programAlias.findMany({
        where: {
          aliasNormalized: aliasKey,
          program: { status: 'active' },
        },
        select: {
          alias: true,
          program: {
            select: {
              id: true,
              canonicalName: true,
              component: true,
              mdapCode: true,
              updatedAt: true,
            },
          },
        },
        take: MAX_EXACT_MATCHES + 1,
      }),
    ]);

    const byId = new Map<
      string,
      {
        id: string;
        canonicalName: string;
        component: string | null;
        mdapCode: string | null;
        updatedAt: Date;
        matchedAlias: string | null;
      }
    >();
    for (const row of canonicalRows) byId.set(row.id, { ...row, matchedAlias: null });
    for (const row of aliasRows) {
      if (!byId.has(row.program.id)) {
        byId.set(row.program.id, { ...row.program, matchedAlias: row.alias });
      }
    }

    return this.boundedResult(
      'program_elements',
      [...byId.values()].map((row) => ({
        domain: 'program_elements',
        recordId: row.id,
        updatedAt: row.updatedAt,
        payload: jsonObject({
          programId: row.id,
          canonicalName: row.canonicalName,
          component: row.component,
          mdapCode: row.mdapCode,
          matchedAlias: row.matchedAlias,
          exactMatchKind: exact.kind,
        }),
        provenance: {
          sourceType: row.matchedAlias ? 'program_alias' : 'program',
          sourceId: row.id,
        },
      })),
      0,
      0,
    );
  }

  private async retrieveBills(
    exact: NormalizedExactLexicalQuery,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    if (exact.kind !== 'bill_id') {
      return this.unsupported(
        'legiwatch_bills',
        request,
        `exact_kind_${exact.kind}_not_supported_for_bills`,
      );
    }

    const rows = await this.prisma.congressBill.findMany({
      where: exact.canonicalBillId
        ? { id: exact.canonicalBillId }
        : {
            billType: exact.billType,
            billNumber: exact.billNumber,
            ...(exact.congress !== undefined ? { congress: exact.congress } : {}),
          },
      select: {
        id: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        status: true,
        url: true,
        lastSyncedAt: true,
      },
      orderBy: [{ congress: 'desc' }, { id: 'asc' }],
      take: MAX_EXACT_MATCHES + 1,
    });

    return this.boundedResult(
      'legiwatch_bills',
      rows.map((row) => ({
        domain: 'legiwatch_bills',
        recordId: row.id,
        updatedAt: row.lastSyncedAt,
        payload: jsonObject({ ...row, exactMatchKind: exact.kind }),
        provenance: { sourceType: 'congress_bill', sourceId: row.id },
      })),
      0,
      0,
    );
  }

  private async retrieveContractOpportunities(
    exact: NormalizedExactLexicalQuery,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    if (exact.kind !== 'contract_id') {
      return this.unsupported(
        'contracts_opportunities',
        request,
        `exact_kind_${exact.kind}_not_supported_for_contract_opportunities`,
      );
    }

    const rows = await this.prisma.$queryRaw<PublicRow[]>`
      SELECT id::text AS record_id,
             jsonb_build_object(
               'id', id,
               'noticeId', notice_id,
               'solicitationNumber', solicitation_number,
               'title', title,
               'noticeType', notice_type,
               'active', active
             ) AS payload,
             updated_at AS updated_at
      FROM sam_opportunity
      WHERE upper(regexp_replace(btrim(notice_id), '[[:space:]]+', '', 'g')) = ${exact.normalizedIdentifier}
         OR upper(regexp_replace(btrim(COALESCE(solicitation_number, '')), '[[:space:]]+', '', 'g')) = ${exact.normalizedIdentifier}
      ORDER BY id
      LIMIT ${MAX_EXACT_MATCHES + 1}
    `;
    return this.completePublic('contracts_opportunities', rows);
  }

  private async retrieveFederalAwards(
    exact: NormalizedExactLexicalQuery,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    if (!['contract_id', 'uei', 'pe_code'].includes(exact.kind)) {
      return this.unsupported(
        'federal_awards',
        request,
        `exact_kind_${exact.kind}_not_supported_for_federal_awards`,
      );
    }

    const rows =
      exact.kind === 'contract_id'
        ? await this.prisma.$queryRaw<PublicRow[]>`
            SELECT id::text AS record_id,
                   jsonb_build_object(
                     'id', id,
                     'awardUniqueId', award_unique_id,
                     'piid', piid,
                     'fain', fain,
                     'contractorName', contractor_name,
                     'recipientUei', recipient_uei,
                     'amount', amount::text,
                     'peCode', pe_code
                   ) AS payload,
                   last_synced_at AS updated_at
            FROM federal_award
            WHERE upper(regexp_replace(btrim(award_unique_id), '[[:space:]]+', '', 'g')) = ${exact.normalizedIdentifier}
               OR upper(regexp_replace(btrim(COALESCE(piid, '')), '[[:space:]]+', '', 'g')) = ${exact.normalizedIdentifier}
               OR upper(regexp_replace(btrim(COALESCE(fain, '')), '[[:space:]]+', '', 'g')) = ${exact.normalizedIdentifier}
            ORDER BY id
            LIMIT ${MAX_EXACT_MATCHES + 1}
          `
        : exact.kind === 'uei'
          ? await this.prisma.$queryRaw<PublicRow[]>`
              SELECT id::text AS record_id,
                     jsonb_build_object(
                       'id', id,
                       'awardUniqueId', award_unique_id,
                       'piid', piid,
                       'fain', fain,
                       'contractorName', contractor_name,
                       'recipientUei', recipient_uei,
                       'amount', amount::text,
                       'peCode', pe_code
                     ) AS payload,
                     last_synced_at AS updated_at
              FROM federal_award
              WHERE upper(regexp_replace(btrim(COALESCE(recipient_uei, '')), '[[:space:]-]+', '', 'g')) = ${exact.normalizedIdentifier}
              ORDER BY id
              LIMIT ${MAX_EXACT_MATCHES + 1}
            `
          : await this.prisma.$queryRaw<PublicRow[]>`
              SELECT id::text AS record_id,
                     jsonb_build_object(
                       'id', id,
                       'awardUniqueId', award_unique_id,
                       'piid', piid,
                       'fain', fain,
                       'contractorName', contractor_name,
                       'recipientUei', recipient_uei,
                       'amount', amount::text,
                       'peCode', pe_code
                     ) AS payload,
                     last_synced_at AS updated_at
              FROM federal_award
              WHERE pe_code = ${exact.normalizedIdentifier}
              ORDER BY id
              LIMIT ${MAX_EXACT_MATCHES + 1}
            `;
    return this.completePublic('federal_awards', rows);
  }

  private completePublic(domain: RetrievalDomain, rows: readonly PublicRow[]): RetrievalSourceResult {
    return this.boundedResult(
      domain,
      rows.map((row) => ({
        domain,
        recordId: row.record_id,
        updatedAt: row.updated_at,
        payload: jsonObject(row.payload),
        provenance: {
          sourceType: domain,
          sourceId: row.record_id,
          matchKind: 'exact_lexical',
        },
      })),
      0,
      0,
    );
  }

  private boundedResult(
    domain: RetrievalDomain,
    candidateRecords: RetrievalRecord[],
    requestedEntityCount: number,
    searchedEntityCount: number,
  ): RetrievalSourceResult {
    const truncated = candidateRecords.length > MAX_EXACT_MATCHES;
    const records = candidateRecords.slice(0, MAX_EXACT_MATCHES);
    return this.result(
      domain,
      records,
      candidateRecords.length,
      requestedEntityCount,
      searchedEntityCount,
      truncated,
    );
  }

  private complete(
    domain: RetrievalDomain,
    records: RetrievalRecord[],
    recordsEvaluated: number,
    requestedEntityCount: number,
    searchedEntityCount: number,
  ): RetrievalSourceResult {
    return this.result(
      domain,
      records,
      recordsEvaluated,
      requestedEntityCount,
      searchedEntityCount,
      false,
    );
  }

  private result(
    domain: RetrievalDomain,
    records: RetrievalRecord[],
    recordsEvaluated: number,
    requestedEntityCount: number,
    searchedEntityCount: number,
    truncated: boolean,
  ): RetrievalSourceResult {
    return {
      domain,
      records,
      total: truncated ? undefined : records.length,
      returned: records.length,
      hasMore: truncated,
      truncated,
      sourceStatus: truncated ? 'degraded' : 'healthy',
      recordsEvaluated,
      requestedEntityCount,
      searchedEntityCount,
      pagesRead: 1,
      paginationComplete: !truncated,
      coverageComplete: !truncated,
      stopReason: truncated
        ? 'exact_lexical_safety_cap_reached'
        : 'authoritative_exact_scan_complete',
    };
  }

  private unsupported(
    domain: RetrievalDomain,
    request: RetrievalRequest,
    stopReason: string,
  ): RetrievalSourceResult {
    return {
      domain,
      records: [],
      returned: 0,
      hasMore: false,
      truncated: false,
      sourceStatus: 'unsupported',
      recordsEvaluated: 0,
      requestedEntityCount: request.caller.clientIds?.length ?? 0,
      searchedEntityCount: 0,
      pagesRead: 0,
      paginationComplete: false,
      coverageComplete: false,
      stopReason,
    };
  }

  private unauthorized(
    domain: RetrievalDomain,
    requestedEntityCount: number,
    searchedEntityCount: number,
    stopReason: string,
  ): RetrievalSourceResult {
    return {
      domain,
      records: [],
      returned: 0,
      hasMore: false,
      truncated: false,
      sourceStatus: 'unauthorized',
      recordsEvaluated: 0,
      requestedEntityCount,
      searchedEntityCount,
      pagesRead: 1,
      paginationComplete: false,
      coverageComplete: false,
      stopReason,
    };
  }
}

function clientWallVisibility(userId: string): Prisma.ClientWhereInput[] {
  return [
    { memoryWall: false },
    { memoryAccessGrants: { some: { userId } } },
  ];
}

function clientExactWhere(exact: NormalizedExactLexicalQuery): Prisma.ClientWhereInput {
  switch (exact.kind) {
    case 'canonical_name':
      return { name: { equals: exact.value, mode: 'insensitive' } };
    case 'domain':
      return { website: { contains: exact.normalizedIdentifier, mode: 'insensitive' } };
    case 'uei':
      return { uei: { equals: exact.normalizedIdentifier, mode: 'insensitive' } };
    case 'cage':
      return { cageCode: { equals: exact.normalizedIdentifier, mode: 'insensitive' } };
    default:
      return {};
  }
}

function canonicalResolverInput(
  exact: NormalizedExactLexicalQuery,
): { query: string; identifiers?: EntityIdentifierInput[]; entityTypeHint?: string } | null {
  switch (exact.kind) {
    case 'canonical_name':
      return { query: exact.value };
    case 'program_name':
      return { query: exact.value, entityTypeHint: 'program' };
    case 'domain':
      return {
        query: '',
        identifiers: [
          { type: 'official_domain', value: exact.normalizedIdentifier },
          { type: 'domain', value: exact.normalizedIdentifier },
        ],
      };
    case 'uei':
    case 'cage':
    case 'cik':
      return {
        query: '',
        identifiers: [{ type: exact.kind, value: exact.normalizedIdentifier }],
      };
    case 'bill_id':
      return exact.canonicalBillId
        ? {
            query: '',
            identifiers: [{ type: 'bill_id', value: exact.canonicalBillId }],
            entityTypeHint: 'bill',
          }
        : null;
    case 'pe_code':
      return {
        query: '',
        identifiers: [{ type: 'program_element_code', value: exact.normalizedIdentifier }],
        entityTypeHint: 'program_element',
      };
    case 'contract_id':
      return {
        query: '',
        identifiers: [{ type: 'contract_id', value: exact.normalizedIdentifier }],
        entityTypeHint: 'contract',
      };
    case 'appropriation_account':
      return null;
  }
}

function dedupeCanonicalCandidates(
  candidates: readonly EntityResolutionCandidate[],
): EntityResolutionCandidate[] {
  const byId = new Map<string, EntityResolutionCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.entity.id);
    if (!current || candidate.confidence > current.confidence) {
      byId.set(candidate.entity.id, candidate);
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.entity.canonicalName.localeCompare(right.entity.canonicalName),
  );
}

export function normalizeExactLexicalQuery(
  input: ExactLexicalQuery,
): NormalizedExactLexicalQuery {
  const value = input.value.normalize('NFKC').trim();
  if (!value) throw new BadRequestException('Exact lexical value is required.');

  switch (input.kind) {
    case 'canonical_name': {
      const normalizedText = normalizeEntityText(value);
      if (!normalizedText) {
        throw new BadRequestException('Canonical name is empty after normalization.');
      }
      return { kind: input.kind, value, normalizedText };
    }
    case 'program_name': {
      const normalizedText = normalizeEntityText(value);
      if (!normalizedText) {
        throw new BadRequestException('Program name is empty after normalization.');
      }
      return { kind: input.kind, value, normalizedText };
    }
    case 'appropriation_account': {
      const normalizedText = normalizeEntityText(value);
      if (!normalizedText) {
        throw new BadRequestException('Appropriation account is empty after normalization.');
      }
      return { kind: input.kind, value, normalizedText };
    }
    case 'domain':
      return {
        kind: input.kind,
        value,
        normalizedIdentifier: normalizeDomain(value),
      };
    case 'uei': {
      const normalizedIdentifier = normalizeEntityIdentifier('uei', value);
      if (!/^[A-Z0-9]{12}$/.test(normalizedIdentifier)) {
        throw new BadRequestException('UEI must contain exactly 12 alphanumeric characters.');
      }
      return { kind: input.kind, value, normalizedIdentifier };
    }
    case 'cage': {
      const normalizedIdentifier = normalizeEntityIdentifier('cage', value);
      if (!/^[A-Z0-9]{5}$/.test(normalizedIdentifier)) {
        throw new BadRequestException('CAGE code must contain exactly 5 alphanumeric characters.');
      }
      return { kind: input.kind, value, normalizedIdentifier };
    }
    case 'cik':
      return {
        kind: input.kind,
        value,
        normalizedIdentifier: normalizeEntityIdentifier('cik', value),
      };
    case 'pe_code':
      return {
        kind: input.kind,
        value,
        normalizedIdentifier: normalizeEntityIdentifier('program_element_code', value),
      };
    case 'contract_id':
      return {
        kind: input.kind,
        value,
        normalizedIdentifier: value.toUpperCase().replace(/\s+/g, ''),
      };
    case 'bill_id':
      return normalizeBillId(value, input.congress);
  }
}

export function normalizeProgramAlias(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBillId(
  value: string,
  congress?: number,
): Extract<NormalizedExactLexicalQuery, { kind: 'bill_id' }> {
  const canonical = value
    .toLocaleLowerCase('en-US')
    .match(/^(\d{1,3})-(hr|s|hres|sres|hjres|sjres|hconres|sconres)-(\d+)$/);
  if (canonical) {
    const parsedCongress = Number(canonical[1]);
    const parsedBillNumber = Number(canonical[3]);
    if (parsedCongress < 1 || parsedBillNumber < 1) {
      throw new BadRequestException('Canonical bill id contains an invalid congress or bill number.');
    }
    return {
      kind: 'bill_id',
      value,
      canonicalBillId: `${parsedCongress}-${canonical[2]}-${parsedBillNumber}`,
      billType: canonical[2]!,
      billNumber: String(parsedBillNumber),
      congress: parsedCongress,
    };
  }

  if (congress !== undefined && (!Number.isInteger(congress) || congress < 1 || congress > 999)) {
    throw new BadRequestException('Congress must be a positive integer no greater than 999.');
  }

  const compact = value.toUpperCase().replace(/[.\s-]+/g, '');
  const display = compact.match(/^(HR|S|HRES|SRES|HJRES|SJRES|HCONRES|SCONRES)(\d+)$/);
  if (!display || Number(display[2]) < 1) {
    throw new BadRequestException(
      'Bill id must be canonical (119-hr-8800) or an exact display id (H.R. 8800).',
    );
  }

  const billType = display[1]!.toLocaleLowerCase('en-US');
  const billNumber = String(Number(display[2]));
  return {
    kind: 'bill_id',
    value,
    ...(congress ? { canonicalBillId: `${congress}-${billType}-${billNumber}` } : {}),
    billType,
    billNumber,
    congress,
  };
}
