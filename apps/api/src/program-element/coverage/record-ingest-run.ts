/**
 * Records a ProgramElementIngestRun row: runs the pure accuracy audit over the
 * extracted records and persists the completeness/quality verdict alongside the
 * loader outcome. This is the "denominator" that lets the coverage report and
 * humans see whether a parse extracted everything it should have.
 *
 * Pure-ish: takes a minimal Prisma-like client so loaders (which use either
 * PrismaService or a bare PrismaClient) can both call it.
 */
import { auditRows, type GuardRow } from '../coverage/pe-coverage.js';

export interface IngestRunClient {
  programElementIngestRun: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface LoadOutcome {
  upserted: number;
  changed: number;
  quarantined: number;
}

export interface RecordIngestRunInput {
  source: string;
  fy?: number | null;
  artifactPath?: string | null;
  artifactSha256?: string | null;
  rows: GuardRow[];
  outcome: LoadOutcome;
  metadata?: Record<string, unknown>;
}

export interface RecordedIngestRun {
  rowsEmitted: number;
  peCodesDistinct: number;
  titleTruncated: number;
  unitsAnomalies: number;
  status: 'ok' | 'warn' | 'fail';
  truncatedSamples: string[];
  anomalySamples: string[];
}

/**
 * Audit the extracted rows and write a ProgramElementIngestRun. Returns the audit
 * so callers can log it / fail CI on a 'fail' verdict. Never throws on a bad
 * verdict — surfacing is the caller's policy choice.
 */
export async function recordIngestRun(
  client: IngestRunClient,
  input: RecordIngestRunInput,
): Promise<RecordedIngestRun> {
  const audit = auditRows(input.rows);
  await client.programElementIngestRun.create({
    data: {
      source: input.source,
      fy: input.fy ?? null,
      artifactPath: input.artifactPath ?? null,
      artifactSha256: input.artifactSha256 ?? null,
      rowsEmitted: audit.rowsEmitted,
      upserted: input.outcome.upserted,
      changed: input.outcome.changed,
      quarantined: input.outcome.quarantined,
      peCodesDistinct: audit.peCodesDistinct,
      titleTruncated: audit.titleTruncated,
      unitsAnomalies: audit.unitsAnomalies,
      status: audit.status,
      notes:
        audit.status === 'ok'
          ? null
          : `truncated=${audit.truncatedSamples.join('; ')} | anomalies=${audit.anomalySamples.join('; ')}`.slice(
              0,
              4000,
            ),
      metadata: input.metadata ?? {},
    },
  });
  return {
    rowsEmitted: audit.rowsEmitted,
    peCodesDistinct: audit.peCodesDistinct,
    titleTruncated: audit.titleTruncated,
    unitsAnomalies: audit.unitsAnomalies,
    status: audit.status,
    truncatedSamples: audit.truncatedSamples,
    anomalySamples: audit.anomalySamples,
  };
}
