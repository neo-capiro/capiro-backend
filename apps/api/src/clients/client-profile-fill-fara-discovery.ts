import { matchesAdvocacyOrganization } from '@capiro/shared';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  AdvocacyBackfillStatus,
  AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';
import {
  faraMatchConfidence,
  resolveFaraMatchedRole,
} from './client-profile-fill-advocacy-mapping.js';
import {
  MAX_ADVOCACY_FINDINGS,
  type PublicAdvocacyDiscoveryPorts,
} from './client-profile-fill-advocacy-discovery.shared.js';

const FARA_AUTO_MATCH_THRESHOLD = 0.5;
const FARA_INTEL_MAPPING_SOURCE = 'fara';

interface FaraCandidate {
  id: string;
  registrationNumber: string;
  registrantName: string;
  foreignPrincipal: string;
  country: string | null;
  status: string | null;
  registrationDate: Date | null;
  description: string | null;
  registrantSimilarity: number;
  principalSimilarity: number;
}

/** Whole role-aware FARA traversal; pending review remains the only client effect. */
export class ClientProfileFillFaraDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: PublicAdvocacyDiscoveryPorts,
  ) {}

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
  ): Promise<{ count: number; backfill: AdvocacySourceBackfillState }> {
    const startedAt = new Date().toISOString();
    const state = (
      status: AdvocacyBackfillStatus,
      examined = 0,
      candidates = 0,
      lastError: string | null = null,
    ) => ({
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint: null,
      historyStart: null,
      examined,
      candidates,
      lastError,
    });
    if (currentCount >= MAX_ADVOCACY_FINDINGS) return { count: 0, backfill: state('in_progress') };

    const clientName = await this.ports.resolveClientName(ctx, clientId);
    if (!clientName) return { count: 0, backfill: state('complete') };

    const confirmedRegistrationNumbers = await this.ports.confirmedMappingKeys(
      ctx,
      clientId,
      FARA_INTEL_MAPPING_SOURCE,
    );

    let candidates: FaraCandidate[];
    try {
      candidates = await this.loadCandidates(clientName, confirmedRegistrationNumbers);
    } catch (error) {
      const lastError = this.ports.safeError(error);
      this.ports.warn(`FARA discovery rail unavailable: ${lastError}`);
      return { count: 0, backfill: state('partial', 0, 0, lastError) };
    }

    let count = 0;
    for (const row of candidates) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      const inserted = await this.emitCandidate(
        ctx,
        clientId,
        runId,
        row,
        confirmedRegistrationNumbers,
        clientName,
      );
      if (inserted) count += 1;
    }
    return { count, backfill: state('complete', candidates.length, count) };
  }

  private async loadCandidates(
    clientName: string,
    confirmedRegistrationNumbers: Set<string>,
  ): Promise<FaraCandidate[]> {
    return this.prisma.$queryRawUnsafe<FaraCandidate[]>(
      `WITH scored AS (
           SELECT fr.id, fr.registration_number AS "registrationNumber",
                  fr.registrant_name AS "registrantName",
                  fr.foreign_principal AS "foreignPrincipal",
                  fr.country, fr.status, fr.registration_date AS "registrationDate",
                  fr.description,
                  GREATEST(similarity(fr.registrant_name, $1), word_similarity($1, fr.registrant_name))::float
                    AS "registrantSimilarity",
                  COALESCE(fp.principal_similarity, 0)::float AS "principalSimilarity"
             FROM fara_registration fr
             LEFT JOIN LATERAL (
               SELECT MAX(GREATEST(similarity(p.principal, $1), word_similarity($1, p.principal)))
                        AS principal_similarity
                 FROM unnest(string_to_array(fr.foreign_principal, '; ')) AS p(principal)
             ) fp ON true
         )
         SELECT * FROM scored
          WHERE "registrationNumber" = ANY($2::text[])
             OR "registrantSimilarity" >= $3::float
             OR "principalSimilarity" >= $3::float
          ORDER BY GREATEST("registrantSimilarity", "principalSimilarity") DESC
          LIMIT 50`,
      clientName,
      [...confirmedRegistrationNumbers],
      FARA_AUTO_MATCH_THRESHOLD,
    );
  }

  private async emitCandidate(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    row: FaraCandidate,
    confirmedRegistrationNumbers: Set<string>,
    clientName: string,
  ): Promise<boolean> {
    const isConfirmed = confirmedRegistrationNumbers.has(row.registrationNumber);
    const registrantMatches = matchesAdvocacyOrganization(clientName, row.registrantName);
    const principalMatches = row.foreignPrincipal
      .split(';')
      .some((name) => matchesAdvocacyOrganization(clientName, name));
    if (!isConfirmed && !registrantMatches && !principalMatches) return false;
    const roleMatch = isConfirmed
      ? resolveFaraMatchedRole(row.registrantSimilarity, row.principalSimilarity)
      : {
          role: principalMatches ? ('foreign_principal' as const) : ('registrant' as const),
          similarity: 1,
        };
    const confidence = faraMatchConfidence(isConfirmed, roleMatch.similarity);
    const externalKey = `fara:${row.registrationNumber}`;
    const proposedValue = {
      externalKey,
      recordType: 'fara_registration',
      title: `FARA registration — ${row.registrantName} for ${row.foreignPrincipal}`,
      summary: row.description,
      activityDate: row.registrationDate?.toISOString() ?? null,
      status: row.status,
      outcome: null,
      sourceType: 'fara',
      sourceId: row.registrationNumber,
      sourceUrl: null,
      evidenceClass: isConfirmed ? 'PUBLIC_VERIFIED' : 'INFERRED',
      confidence,
      metadata: {
        registrationNumber: row.registrationNumber,
        registrantName: row.registrantName,
        foreignPrincipal: row.foreignPrincipal,
        country: row.country,
        clientMatch: {
          method: isConfirmed ? 'confirmed_client_intel_mapping' : 'organization_name',
          confidence,
          similarity: isConfirmed ? null : roleMatch.similarity,
          // Which FARA identity field matched the client. 'foreign_principal'
          // also covers the roadmap's "represented entity" role — this
          // schema has no separate column for that concept (see class doc).
          // Absent for a confirmed mapping with no live similarity signal
          // on either side (score 0/0) — a human already decided the
          // match; there is nothing informative to report about role.
          matchedRole: isConfirmed && roleMatch.similarity === 0 ? null : roleMatch.role,
        },
      },
    };
    const inserted = await this.ports.emitFinding(ctx, clientId, runId, {
      externalKey,
      isConfirmed,
      confidence,
      proposedValue,
      evidence: [
        {
          label: proposedValue.title,
          source: 'FARA (Foreign Agents Registration Act) registration',
          metadata: { registrationNumber: row.registrationNumber, matchedRole: roleMatch.role },
        },
      ],
    });
    return inserted;
  }
}
