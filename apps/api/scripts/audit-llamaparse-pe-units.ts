/**
 * SELECT-only audit for historical generalized LlamaParse PE money.
 *
 * The report identifies rows whose CANONICAL winning source is LlamaParse and
 * whose value is approximately 1,000x a same-PE/FY/field deterministic source.
 * It never divides values, never writes a repair, never advances a watermark,
 * and never treats magnitude alone as proof.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  classifyUnitAuditFinding,
  classifyUnitRatio,
  type UnitRatioClassification,
} from './lib/defense-budget-commit.js';

dotenvConfig();

const MONEY_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];

interface ComparatorEvidence {
  source: string;
  /** Null when the stored decimal does not parse to a finite number. */
  valueM: number | null;
  classification: UnitRatioClassification;
  sourceDocumentId: string | null;
}

interface AuditFinding {
  peCode: string;
  fy: number;
  fieldName: MoneyField;
  canonicalValue: number | null;
  canonicalSource: string | null;
  llamaValue: number | null;
  llamaSource: string | null;
  sourceDocument: {
    id: string;
    sourceKey: string;
    sha256: string | null;
    archiveBucket: string | null;
    archiveS3Key: string | null;
    archiveVersionId: string | null;
    extractionMethod: string;
  } | null;
  successfulParseJobs: Array<{
    id: string;
    inputSha256: string;
    outputJsonS3Key: string | null;
    completedAt: string | null;
  }>;
  deterministicComparators: ComparatorEvidence[];
  /**
   * The exact preserved artifact an approved repair should replay from, so an
   * operator never re-runs a paid vendor parse to reconstruct a known value.
   * Null when no succeeded parse job matches the source SHA.
   */
  recommendedReplaySource: {
    parseJobId: string;
    inputSha256: string;
    outputJsonS3Key: string;
    archiveBucket: string | null;
    archiveS3Key: string | null;
    archiveVersionId: string | null;
  } | null;
  reason: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sampleLimit(): number {
  const raw = arg('limit');
  if (raw == null) return 500;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return parsed;
}

function buildDatabaseUrlFromParts(): void {
  if (process.env.DATABASE_URL) return;
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`DATABASE_URL is unset and required DB_* values are missing: ${missing.join(', ')}`);
  }
  const password = encodeURIComponent(process.env.DB_PASSWORD!);
  process.env.DATABASE_URL =
    `postgresql://${process.env.DB_USER}:${password}@${process.env.DB_HOST}:` +
    `${process.env.DB_PORT}/${process.env.DB_NAME}?schema=public&sslmode=require&connection_limit=10`;
}

function databaseHost(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return 'UNAVAILABLE';
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return 'UNPARSEABLE_DATABASE_URL';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(
    typeof value === 'object' && 'toString' in value
      ? (value as { toString(): string }).toString()
      : value,
  );
  return Number.isFinite(numeric) ? numeric : null;
}

function isLlamaSource(source: string, extractionMethod: string | null | undefined): boolean {
  return source.toLowerCase().startsWith('llamaparse_') || extractionMethod === 'llamaparse';
}

function key(peCode: string, fy: number, fieldName: string): string {
  return `${peCode}|${fy}|${fieldName}`;
}

async function main(): Promise<void> {
  buildDatabaseUrlFromParts();
  const limit = sampleLimit();
  const prisma = new PrismaClient();

  try {
    const [canonicalRows, observations] = await Promise.all([
      prisma.programElementYear.findMany({
        select: {
          peCode: true,
          fy: true,
          request: true,
          hascMark: true,
          sascMark: true,
          hacDMark: true,
          sacDMark: true,
          conference: true,
          ndaaConference: true,
          enacted: true,
          reprogrammed: true,
          executed: true,
          raw: true,
        },
        orderBy: [{ peCode: 'asc' }, { fy: 'asc' }],
      }),
      prisma.programElementYearSourceValue.findMany({
        where: {
          fieldName: { in: [...MONEY_FIELDS] },
          valueDecimal: { not: null },
        },
        select: {
          peCode: true,
          fy: true,
          fieldName: true,
          source: true,
          valueDecimal: true,
          sourceDocumentId: true,
          recordedAt: true,
          sourceDocument: {
            select: {
              id: true,
              sourceKey: true,
              sha256: true,
              archiveBucket: true,
              archiveS3Key: true,
              archiveVersionId: true,
              extractionMethod: true,
              parseJobs: {
                where: { provider: 'llamaparse', status: 'succeeded' },
                select: {
                  id: true,
                  inputSha256: true,
                  outputJsonS3Key: true,
                  completedAt: true,
                },
                orderBy: { completedAt: 'desc' },
              },
            },
          },
        },
        orderBy: { recordedAt: 'desc' },
      }),
    ]);

    const byField = new Map<string, typeof observations>();
    for (const observation of observations) {
      const k = key(observation.peCode, observation.fy, observation.fieldName);
      const rows = byField.get(k) ?? [];
      rows.push(observation);
      byField.set(k, rows);
    }

    const provenAffected: AuditFinding[] = [];
    const needsHumanReview: AuditFinding[] = [];
    const notAffected: AuditFinding[] = [];
    let examined = 0;

    for (const row of canonicalRows) {
      const raw = asRecord(row.raw);
      const fieldSources = asStringMap(raw.fieldSources);

      for (const fieldName of MONEY_FIELDS) {
        const fieldObservations = byField.get(key(row.peCode, row.fy, fieldName)) ?? [];
        const llamaObservations = fieldObservations.filter((observation) =>
          isLlamaSource(observation.source, observation.sourceDocument?.extractionMethod),
        );
        if (llamaObservations.length === 0) continue;
        examined += 1;

        const canonicalValue = toNumber(row[fieldName]);
        const canonicalSource = fieldSources[fieldName] ?? null;
        const canonicalIsLlama = canonicalSource
          ? isLlamaSource(canonicalSource, null)
          : false;
        const llama = llamaObservations[0]!;
        const llamaValue = canonicalIsLlama
          ? canonicalValue
          : toNumber(llama.valueDecimal);
        const deterministic = fieldObservations.filter(
          (observation) =>
            !isLlamaSource(observation.source, observation.sourceDocument?.extractionMethod),
        );
        // No non-null assertion here: `valueDecimal` is non-null in the query, but
        // toNumber() also returns null for a value that does not parse finitely, and
        // claiming `number` for that would put a null into a numeric report field.
        const deterministicComparators: ComparatorEvidence[] = deterministic.map((observation) => {
          const comparatorValue = toNumber(observation.valueDecimal);
          return {
            source: observation.source,
            valueM: comparatorValue,
            classification: classifyUnitRatio(llamaValue, comparatorValue),
            sourceDocumentId: observation.sourceDocumentId,
          };
        });
        const sourceDocument = llama.sourceDocument
          ? {
              id: llama.sourceDocument.id,
              sourceKey: llama.sourceDocument.sourceKey,
              sha256: llama.sourceDocument.sha256,
              archiveBucket: llama.sourceDocument.archiveBucket,
              archiveS3Key: llama.sourceDocument.archiveS3Key,
              archiveVersionId: llama.sourceDocument.archiveVersionId,
              extractionMethod: llama.sourceDocument.extractionMethod,
            }
          : null;
        const successfulParseJobs = (llama.sourceDocument?.parseJobs ?? []).map((job) => ({
          id: job.id,
          inputSha256: job.inputSha256,
          outputJsonS3Key: job.outputJsonS3Key,
          completedAt: job.completedAt?.toISOString() ?? null,
        }));
        const hasArchiveProof = Boolean(
          sourceDocument?.sha256 &&
            sourceDocument.archiveBucket &&
            sourceDocument.archiveS3Key &&
            sourceDocument.archiveVersionId,
        );
        const hasMatchingParseProof = Boolean(
          sourceDocument?.sha256 &&
            successfulParseJobs.some(
              (job) => job.inputSha256 === sourceDocument.sha256 && job.outputJsonS3Key,
            ),
        );
        const replayJob = successfulParseJobs.find(
          (job) => job.inputSha256 === sourceDocument?.sha256 && job.outputJsonS3Key,
        );

        const common = {
          peCode: row.peCode,
          fy: row.fy,
          fieldName,
          canonicalValue,
          canonicalSource,
          llamaValue,
          llamaSource: llama.source,
          sourceDocument,
          successfulParseJobs,
          deterministicComparators,
          recommendedReplaySource:
            replayJob && replayJob.outputJsonS3Key
              ? {
                  parseJobId: replayJob.id,
                  inputSha256: replayJob.inputSha256,
                  outputJsonS3Key: replayJob.outputJsonS3Key,
                  archiveBucket: sourceDocument?.archiveBucket ?? null,
                  archiveS3Key: sourceDocument?.archiveS3Key ?? null,
                  archiveVersionId: sourceDocument?.archiveVersionId ?? null,
                }
              : null,
        };

        // The proof rule lives in a pure, unit-tested function so it is verified by
        // execution rather than by asserting the text of this condition.
        const verdict = classifyUnitAuditFinding({
          canonicalIsLlama,
          classifications: deterministicComparators.map((comparator) => comparator.classification),
          hasArchiveProof,
          hasMatchingParseProof,
        });
        const finding: AuditFinding = { ...common, reason: verdict.reason };
        if (verdict.bucket === 'provenAffected') provenAffected.push(finding);
        else if (verdict.bucket === 'notAffected') notAffected.push(finding);
        else needsHumanReview.push(finding);
      }
    }

    const truncate = (rows: AuditFinding[]): AuditFinding[] => rows.slice(0, limit);
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          database: databaseHost(),
          canonicalMoneyUnit: 'USD millions',
          mutationPolicy: 'SELECT_ONLY_NO_AUTOMATIC_DIVISION',
          proofRule:
            'provenAffected requires a LlamaParse canonical winner, immutable source/archive linkage, a succeeded parse artifact for the same source SHA, and a same-PE/FY/field deterministic observation approximately 1,000x smaller.',
          counts: {
            canonicalPeYearRows: canonicalRows.length,
            numericSourceObservations: observations.length,
            llamaFieldsExamined: examined,
            provenAffected: provenAffected.length,
            needsHumanReview: needsHumanReview.length,
            notAffected: notAffected.length,
          },
          outputLimitPerBucket: limit,
          provenAffected: truncate(provenAffected),
          needsHumanReview: truncate(needsHumanReview),
          notAffected: truncate(notAffected),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[audit-llamaparse-pe-units] ${message}`);
  process.exit(1);
});
