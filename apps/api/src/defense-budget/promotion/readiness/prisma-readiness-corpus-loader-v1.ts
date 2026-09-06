import type { ExpectedSourceState, SourceFamily } from '@capiro/defense-domain';
import { routingForSourceFamily } from '../../parser-router/source-family-routing.js';
import {
  reconstructReadinessIngestionOutcomeV1,
  type CycleFamilyCorpusInputV1,
  type CycleFamilyReadinessIdentityV1,
  type DurableReadinessIngestionFactsV1,
} from './cycle-family-readiness-v1.js';
import type { ReadinessCorpusLoaderPortV1 } from './cycle-family-readiness-orchestrator-v1.js';

export interface ReadinessPrismaQueryPortV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

type ExpectedRow = { id: string; sourceFamily: string; expectedState: string; optional: boolean };
type ObservationRow = {
  expectedSourceId: string;
  observationState: string;
  sourceDocumentId: string | null;
  contentSha256: string;
  lastSeenAt: Date;
};

/**
 * Restart-safe corpus loader. It reconstructs ingestion from persisted source,
 * parser, candidate, and verification rows via
 * `reconstructReadinessIngestionOutcomeV1`; it never consumes the transient
 * `ObservationIngestionBridgeResult` returned by the bridge process — a
 * fresh process with no bridge result in memory (e.g. this class running
 * from a cold CLI invocation) produces the identical outcome.
 */
export class PrismaReadinessCorpusLoaderV1 implements ReadinessCorpusLoaderPortV1 {
  constructor(
    private readonly prisma: ReadinessPrismaQueryPortV1,
    private readonly logInvariant: (message: string) => void = console.warn,
  ) {}

  async loadCorpus(identity: CycleFamilyReadinessIdentityV1): Promise<CycleFamilyCorpusInputV1> {
    const cycles = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "defense_budget_cycle"
        WHERE "fiscal_year" = $1 AND "authority_track" = $2 LIMIT 1`,
      identity.fiscalYear,
      identity.authorityTrack,
    );
    const cycle = cycles[0];
    if (cycle == null) throw new Error(`defense_budget_cycle_not_found:${identity.fiscalYear}:${identity.authorityTrack}`);

    // Phase 10B-28R: every scalar parameter compared with a uuid column is
    // cast explicitly. Prisma sends string parameters as `text`, and Postgres
    // has no `uuid = text` operator -- against a real database these queries
    // failed with 42883 the first time a cycle actually existed (proven by
    // verification/persistence/lifecycle-bridge-candidate-cycle-identity.
    // integration.spec.ts). The table-routed fakes never exercised the
    // parameter types, which is why this stayed latent.
    const allExpected = await this.prisma.$queryRawUnsafe<ExpectedRow[]>(
      `SELECT "id", "source_family" AS "sourceFamily", "expected_state" AS "expectedState", "optional"
         FROM "defense_budget_expected_source" WHERE "cycle_id" = $1::uuid ORDER BY "id"`,
      cycle.id,
    );
    const expected = allExpected.filter((row) =>
      routingForSourceFamily(row.sourceFamily as SourceFamily).family === identity.familyGroup,
    );
    const ids = expected.map((row) => row.id);
    const observations = ids.length === 0 ? [] : await this.prisma.$queryRawUnsafe<ObservationRow[]>(
      `SELECT "expected_source_id" AS "expectedSourceId", "observation_state" AS "observationState",
              "source_document_id" AS "sourceDocumentId", "content_sha256" AS "contentSha256",
              "last_seen_at" AS "lastSeenAt"
         FROM "defense_budget_source_observation"
        WHERE "expected_source_id" = ANY($1::uuid[])
        ORDER BY "last_seen_at" DESC`,
      ids,
    );

    return {
      identity,
      cycleId: cycle.id,
      expectedSources: await Promise.all(expected.map(async (row) => {
        const rows = observations.filter((observation) => observation.expectedSourceId === row.id);
        // Prefer the newest ingested/changed observation; a newer unclassified
        // duplicate must not hide an older observation with a durable binding.
        const relevant = rows.filter((observation) =>
          observation.observationState === 'ingested' || observation.observationState === 'changed',
        );
        const observation = (relevant.length > 0 ? relevant : rows).sort(
          (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
        )[0] ?? null;
        const facts = await this.loadDurableFacts(observation);
        return {
          expectedSourceId: row.id,
          sourceFamily: row.sourceFamily,
          optional: row.optional,
          expectedState: row.expectedState as ExpectedSourceState,
          latestIngestion: observation == null ? null : reconstructReadinessIngestionOutcomeV1(facts),
        };
      })),
    };
  }

  private async loadDurableFacts(observation: ObservationRow | null): Promise<DurableReadinessIngestionFactsV1> {
    if (observation?.sourceDocumentId == null) {
      return { observation, sourceDocument: null, parseJobs: [], candidates: [], verificationRuns: [] };
    }
    const [document] = await this.prisma.$queryRawUnsafe<Array<{ id: string; sha256: string | null }>>(
      `SELECT "id", "sha256" FROM "source_document" WHERE "id" = $1::uuid`, observation.sourceDocumentId,
    );
    if (document == null || document.sha256 !== observation.contentSha256) {
      this.logInvariant(`readiness durable invariant violation for observation source document ${observation.sourceDocumentId}`);
      return { observation, sourceDocument: document ?? null, parseJobs: [], candidates: [], verificationRuns: [] };
    }
    const parseJobs = await this.prisma.$queryRawUnsafe<Array<{ inputSha256: string; status: string }>>(
      `SELECT "input_sha256" AS "inputSha256", "status" FROM "document_parse_job"
        WHERE "source_document_id" = $1::uuid AND "input_sha256" = $2 AND "status" = 'succeeded'`,
      document.id, document.sha256,
    );
    const candidates = await this.prisma.$queryRawUnsafe<DurableReadinessIngestionFactsV1['candidates']>(
      `SELECT "id", "source_document_id" AS "sourceDocumentId", "source_sha256" AS "sourceSha256",
              "current_run_id" AS "currentRunId" FROM "budget_extraction_candidate_v1"
        WHERE "source_document_id" = $1::uuid AND "source_sha256" = $2 ORDER BY "created_at" DESC`,
      document.id, document.sha256,
    );
    const candidate = candidates[0];
    const verificationRuns = candidate == null ? [] : await this.prisma.$queryRawUnsafe<DurableReadinessIngestionFactsV1['verificationRuns']>(
      `SELECT "id", "candidate_id" AS "candidateId", "decision", "completed_at" AS "completedAt"
         FROM "budget_verification_run_v1" WHERE "candidate_id" = $1::uuid ORDER BY "completed_at" DESC`,
      candidate.id,
    );
    return { observation, sourceDocument: document, parseJobs, candidates, verificationRuns };
  }
}
