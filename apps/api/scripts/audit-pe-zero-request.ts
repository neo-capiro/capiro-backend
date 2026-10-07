/**
 * SELECT-only audit for PE years whose canonical `request` is 0 while another
 * observation records a non-zero request (PE 0603203F FY2027: $0.0M stored,
 * $72,149,000 restated by the HASC report).
 *
 * It lists every such (pe_code, fy) with the current winner and every non-zero
 * observation, and classifies each finding:
 *  - `pbAuthorityConflict`: a source that may own `request` (the President's
 *    budget) recorded a non-zero value, so the $0 winner is a lineage defect a
 *    re-pick could correct after review;
 *  - `committeeRestatementOnly`: only sources that can never own `request`
 *    (committee reports restating the request line) disagree, so nothing may be
 *    re-picked and the PB document must be re-checked first.
 *
 * It never writes, never re-picks a winner, and never treats a committee figure
 * as the request. The model-facing guard (renderPeFundingForModel) already
 * stops a contradicted $0 from being cited.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { authorityForSource, mayOwnCanonicalField } from '../src/program-element/program-element-field-ownership.js';

dotenvConfig();

export interface ZeroRequestObservation {
  source: string;
  valueM: number;
  sourceDocumentId: string | null;
  pageNumber: number | null;
  parseJobId: string | null;
  isWinner: boolean;
  lastObservedAt: string | null;
}

export type ZeroRequestBucket = 'pbAuthorityConflict' | 'committeeRestatementOnly';

export interface ZeroRequestFinding {
  peCode: string;
  fy: number;
  winnerSource: string | null;
  bucket: ZeroRequestBucket;
  /** Distinct non-zero values ($M) from sources that may own `request`. */
  requestOwnerValuesM: number[];
  observations: ZeroRequestObservation[];
}

/** Pure: which bucket a contradicted $0 request falls into. */
export function classifyZeroRequestFinding(
  observations: readonly Pick<ZeroRequestObservation, 'source' | 'valueM'>[],
): { bucket: ZeroRequestBucket; requestOwnerValuesM: number[] } {
  const ownerValues = observations
    .filter(
      (observation) =>
        Number.isFinite(observation.valueM) &&
        observation.valueM !== 0 &&
        mayOwnCanonicalField(
          authorityForSource(observation.source),
          'request',
          'production',
          observation.source,
        ),
    )
    .map((observation) => observation.valueM);
  const requestOwnerValuesM = [...new Set(ownerValues)].sort((a, b) => a - b);
  return {
    bucket: requestOwnerValuesM.length ? 'pbAuthorityConflict' : 'committeeRestatementOnly',
    requestOwnerValuesM,
  };
}

interface Row {
  pe_code: string;
  fy: number;
  winner_source: string | null;
  observations: Array<{
    source: string;
    valueM: string | number;
    sourceDocumentId: string | null;
    pageNumber: number | null;
    parseJobId: string | null;
    isWinner: boolean;
    lastObservedAt: string | null;
  }>;
}

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').host || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, Number(limitArg.slice('--limit='.length)) || 200) : 200;
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        y.pe_code,
        y.fy,
        (
          SELECT w.source
          FROM program_element_year_source_value w
          WHERE w.pe_code = y.pe_code AND w.fy = y.fy AND w.field_name = 'request' AND w.is_winner
          ORDER BY w.last_observed_at DESC
          LIMIT 1
        ) AS winner_source,
        json_agg(
          json_build_object(
            'source', o.source,
            'valueM', o.canonical_value_m,
            'sourceDocumentId', o.source_document_id,
            'pageNumber', o.page_number,
            'parseJobId', o.parse_job_id,
            'isWinner', o.is_winner,
            'lastObservedAt', o.last_observed_at
          )
          ORDER BY o.last_observed_at DESC
        ) AS observations
      FROM program_element_year y
      JOIN program_element_year_source_value o
        ON o.pe_code = y.pe_code
       AND o.fy = y.fy
       AND o.field_name = 'request'
       AND o.canonical_value_m IS NOT NULL
       AND o.canonical_value_m <> 0
      WHERE y.request = 0
      GROUP BY y.pe_code, y.fy
      ORDER BY y.pe_code, y.fy
    `);

    const findings: ZeroRequestFinding[] = rows.map((row) => {
      const observations = row.observations.map((observation) => ({
        ...observation,
        valueM: Number(observation.valueM),
      }));
      return {
        peCode: row.pe_code,
        fy: row.fy,
        winnerSource: row.winner_source,
        ...classifyZeroRequestFinding(observations),
        observations,
      };
    });
    const bucket = (name: ZeroRequestBucket) => findings.filter((finding) => finding.bucket === name);
    const named = findings.find((finding) => finding.peCode === '0603203F' && finding.fy === 2027);

    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          database: databaseHost(),
          canonicalMoneyUnit: 'USD millions',
          mutationPolicy: 'SELECT_ONLY_NO_REPICK',
          rule: 'A finding is a PE year with canonical request = 0 and at least one non-zero request observation. pbAuthorityConflict: a source that may own request disagrees. committeeRestatementOnly: only sources that can never own request disagree.',
          counts: {
            findings: findings.length,
            pbAuthorityConflict: bucket('pbAuthorityConflict').length,
            committeeRestatementOnly: bucket('committeeRestatementOnly').length,
          },
          namedCheck: { peCode: '0603203F', fy: 2027, finding: named ?? null },
          outputLimitPerBucket: limit,
          pbAuthorityConflict: bucket('pbAuthorityConflict').slice(0, limit),
          committeeRestatementOnly: bucket('committeeRestatementOnly').slice(0, limit),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /audit-pe-zero-request\.[cm]?[jt]s$/.test(process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[audit-pe-zero-request] ${message}`);
    process.exit(1);
  });
}
