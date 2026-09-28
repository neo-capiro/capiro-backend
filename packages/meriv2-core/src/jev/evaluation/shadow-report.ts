import { hashEvidenceContent } from '../../grounding/evidence';
import { EVIDENCE_OUTCOMES, type EvidenceOutcome } from '../decision-contract';
import type { JevClaimEvidenceFixture } from '../fixture-schema';
import {
  joinWithLabels,
  type EvidenceShadowEvent,
  type EvidenceShadowTurnEvent,
  type HumanLabels,
  type JoinedShadowRow,
  type ShadowEvent,
} from './shadow-events';

const FAILURE_STATES = [
  'not_checked',
  'retrieval_failed',
  'document_unavailable',
  'judge_unavailable',
  'repair_budget_exhausted',
  'timeout',
  'cancelled',
  'malformed_response',
  'scope_refused',
] as const;
const RESULT_KEYS = [
  ...EVIDENCE_OUTCOMES,
  ...FAILURE_STATES.map((state) => `failure:${state}`),
] as const;
type ProviderName = 'jev' | 'legacy';

type Counts = Record<string, number>;

function resultKey(decision: JoinedShadowRow[ProviderName]): string {
  return decision.kind === 'outcome' ? decision.outcome : `failure:${decision.state}`;
}

function emptyCounts(keys: readonly string[]): Counts {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function distribution(rows: readonly JoinedShadowRow[], provider: ProviderName): Counts {
  const counts = emptyCounts(RESULT_KEYS);
  for (const row of rows)
    counts[resultKey(row[provider])] = (counts[resultKey(row[provider])] ?? 0) + 1;
  return counts;
}

function metric(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function labeledMetrics(rows: readonly JoinedShadowRow[], provider: ProviderName) {
  const labeled = rows.filter((row) => row.humanLabel !== null);
  const confusion = Object.fromEntries(
    EVIDENCE_OUTCOMES.map((label) => [label, emptyCounts(RESULT_KEYS)]),
  );
  for (const row of labeled) {
    const expected = confusion[row.humanLabel!];
    if (expected)
      expected[resultKey(row[provider])] = (expected[resultKey(row[provider])] ?? 0) + 1;
  }
  const perOutcome = Object.fromEntries(
    EVIDENCE_OUTCOMES.map((outcome) => {
      const truePositive = labeled.filter(
        (row) => row.humanLabel === outcome && resultKey(row[provider]) === outcome,
      ).length;
      const predicted = labeled.filter((row) => resultKey(row[provider]) === outcome).length;
      const actual = labeled.filter((row) => row.humanLabel === outcome).length;
      return [
        outcome,
        {
          accuracy: metric(
            labeled.filter(
              (row) => (resultKey(row[provider]) === outcome) === (row.humanLabel === outcome),
            ).length,
            labeled.length,
          ),
          precision: metric(truePositive, predicted),
          recall: metric(truePositive, actual),
          support: actual,
        },
      ];
    }),
  );
  return {
    labeled: labeled.length,
    unlabeled: rows.length - labeled.length,
    accuracy: metric(
      labeled.filter((row) => resultKey(row[provider]) === row.humanLabel).length,
      labeled.length,
    ),
    perOutcome,
    confusion,
  };
}

function grouped(
  rows: readonly JoinedShadowRow[],
  field: 'claimCategory' | 'claimKind',
  provider: ProviderName,
) {
  return Object.fromEntries(
    [...new Set(rows.map((row) => row[field]))].sort().map((value) => {
      const selected = rows.filter((row) => row[field] === value);
      return [
        value,
        {
          total: selected.length,
          distribution: distribution(selected, provider),
          ...labeledMetrics(selected, provider),
        },
      ];
    }),
  );
}

function calibration(rows: readonly JoinedShadowRow[]) {
  return Array.from({ length: 10 }, (_, index) => {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const selected = rows.filter(
      (row) =>
        row.humanLabel !== null &&
        row.jev.kind === 'outcome' &&
        row.jev.confidence >= lower &&
        (index === 9 ? row.jev.confidence <= upper : row.jev.confidence < upper),
    );
    return {
      lower,
      upper,
      count: selected.length,
      meanConfidence: selected.length
        ? selected.reduce(
            (sum, row) => sum + (row.jev.kind === 'outcome' ? row.jev.confidence : 0),
            0,
          ) / selected.length
        : null,
      accuracy: metric(
        selected.filter((row) => resultKey(row.jev) === row.humanLabel).length,
        selected.length,
      ),
    };
  });
}

function assertSingleProviderVersion(
  rows: readonly JoinedShadowRow[],
  provider: ProviderName,
): { model: string | null; questionVersion: string | null } {
  const models = [...new Set(rows.map((row) => row[provider].model))].sort();
  const versions = [...new Set(rows.map((row) => row[provider].questionVersion))].sort();
  if (models.length > 1 || versions.length > 1) {
    throw new Error(
      `${provider} report cannot mix models [${models.join(', ')}] or question versions [${versions.join(', ')}]`,
    );
  }
  return { model: models[0] ?? null, questionVersion: versions[0] ?? null };
}

function assertCrossProviderQuestionVersion(rows: readonly JoinedShadowRow[]): void {
  const versions = [
    ...new Set(rows.flatMap((row) => [row.jev.questionVersion, row.legacy.questionVersion])),
  ].sort();
  if (versions.length > 1) {
    throw new Error(`report cannot mix question versions [${versions.join(', ')}]`);
  }
}

function assertSingleLegacyAdapterVersion(rows: readonly JoinedShadowRow[]): string | null {
  const versions = [...new Set(rows.map((row) => row.legacyAdapterVersion))].sort();
  if (versions.length > 1) {
    throw new Error(`legacy report cannot mix adapter versions [${versions.join(', ')}]`);
  }
  return versions[0] ?? null;
}

function turnKey(row: { conversationId: string | null; turnId: string | null }): string {
  return `${row.conversationId ?? ''}:${row.turnId ?? ''}`;
}

function providerReport(rows: readonly JoinedShadowRow[], provider: ProviderName) {
  const version = assertSingleProviderVersion(rows, provider);
  const failures = rows.filter((row) => row[provider].kind === 'failure').length;
  return {
    ...version,
    outcomeDistribution: distribution(rows, provider),
    agreementRate: metric(rows.filter((row) => row.agreement).length, rows.length),
    metrics: labeledMetrics(rows, provider),
    byClaimCategory: grouped(rows, 'claimCategory', provider),
    byClaimKind: grouped(rows, 'claimKind', provider),
    operationalFailureRate: metric(failures, rows.length),
    inputTokens: rows.reduce((sum, row) => sum + row[provider].inputTokens, 0),
  };
}

export interface ShadowReportInput {
  events: readonly ShadowEvent[];
  fixtures?: JevClaimEvidenceFixture | readonly [];
  labels?: HumanLabels;
  split: 'tuning' | 'heldout' | 'all';
  rejectedLines?: number;
}

export function renderShadowReportMarkdown(report: Omit<ShadowReport, 'markdown'>): string {
  const rate = (value: number | null) => (value === null ? 'n/a' : value.toFixed(3));
  return `# Jev paired-shadow evaluation\n\n- Split: ${report.split}\n- Claim events: ${report.counts.claimEvents}\n- Live claim events: ${report.counts.liveClaimEvents}\n- Replay claim events: ${report.counts.replayClaimEvents}\n- Replay misses: ${report.counts.replayMisses}\n- Rejected event lines: ${report.counts.rejectedLines}\n- Content hash: \`${report.hash}\`\n\n${report.counts.liveClaimEvents === 0 ? '## No live events\n\nNo live paired-shadow claim events were supplied.\n\n' : ''}## Provider summary\n\n| Provider | Model | Question | Agreement | Labeled accuracy | Failure rate | Input tokens |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n| Jev | ${report.providers.jev.model ?? 'n/a'} | ${report.providers.jev.questionVersion ?? 'n/a'} | ${rate(report.providers.jev.agreementRate)} | ${rate(report.providers.jev.metrics.accuracy)} | ${rate(report.providers.jev.operationalFailureRate)} | ${report.providers.jev.inputTokens} |\n| Legacy | ${report.providers.legacy.model ?? 'n/a'} | ${report.providers.legacy.questionVersion ?? 'n/a'} | ${rate(report.providers.legacy.agreementRate)} | ${rate(report.providers.legacy.metrics.accuracy)} | ${rate(report.providers.legacy.operationalFailureRate)} | ${report.providers.legacy.inputTokens} |\n\n## Disagreement digest\n\n${report.disagreements.length ? report.disagreements.map((row) => `- ${row.claimId}: ${row.jev} vs ${row.legacy}; \`${row.envelopeHash}\`; ${row.claimText}`).join('\n') : '- None'}\n`;
}

export type ShadowReport = ReturnType<typeof buildReportPayload> & {
  hash: string;
  markdown: string;
};

function buildReportPayload(
  input: ShadowReportInput,
  rows: JoinedShadowRow[],
  turns: EvidenceShadowTurnEvent[],
) {
  const sampledTurns = new Set(turns.filter((turn) => turn.sampled).map(turnKey));
  const disagreements = rows
    .filter((row) => !row.agreement)
    .map((row) => ({
      claimId: row.claimId,
      claimText: (row.claimText ?? '[claim text unavailable]').slice(0, 160),
      jev: resultKey(row.jev),
      legacy: resultKey(row.legacy),
      envelopeHash: row.envelopeHash,
    }));
  const replayMisses = rows.filter(
    (row) =>
      row.source === 'replay' && (row.jev.kind === 'failure' || row.legacy.kind === 'failure'),
  ).length;
  return {
    reportVersion: 'jev_shadow_report_v1' as const,
    split: input.split,
    task: 'claim_support',
    counts: {
      claimEvents: rows.length,
      turnEvents: turns.length,
      liveClaimEvents: rows.filter((row) => row.source === 'live').length,
      replayClaimEvents: rows.filter((row) => row.source === 'replay').length,
      replayMisses,
      labeled: rows.filter((row) => row.humanLabel !== null).length,
      unlabeled: rows.filter((row) => row.humanLabel === null).length,
      rejectedLines: input.rejectedLines ?? 0,
    },
    providers: {
      jev: providerReport(rows, 'jev'),
      legacy: {
        ...providerReport(rows, 'legacy'),
        adapterVersion: assertSingleLegacyAdapterVersion(rows),
      },
    },
    byTaskQuestionVersion: Object.fromEntries(
      ['jev', 'legacy'].map((provider) => {
        const typed = provider as ProviderName;
        const key = `claim_support:${rows[0]?.[typed].questionVersion ?? 'none'}`;
        return [provider, { [key]: rows.length }];
      }),
    ),
    confidenceCalibration: calibration(rows),
    sampledAgreements: rows
      .filter((row) => row.agreement && sampledTurns.has(turnKey(row)))
      .map((row) => ({
        claimId: row.claimId,
        envelopeHash: row.envelopeHash,
      })),
    disagreements,
    operations: {
      budgetExhaustedTurns: turns.filter((turn) => turn.budgetExhausted).length,
      skippedClaims: turns.reduce((sum, turn) => sum + turn.skipped, 0),
      inputTokens: turns.reduce((sum, turn) => sum + turn.inputTokens, 0),
      estimatedCostUsd: turns.reduce((sum, turn) => sum + turn.estimatedCostUsd, 0),
    },
  };
}

export function buildShadowReport(input: ShadowReportInput): ShadowReport {
  const claims = input.events.filter(
    (event): event is EvidenceShadowEvent => event.event === 'meri.evidence_shadow',
  );
  const turns = input.events.filter(
    (event): event is EvidenceShadowTurnEvent => event.event === 'meri.evidence_shadow.turn',
  );
  const fixtures = Array.isArray(input.fixtures)
    ? undefined
    : (input.fixtures as JevClaimEvidenceFixture | undefined);
  const joined = joinWithLabels(claims, fixtures, input.labels);
  const rows = input.split === 'all' ? joined : joined.filter((row) => row.split === input.split);
  assertCrossProviderQuestionVersion(rows);
  const payload = buildReportPayload(input, rows, turns);
  const hash = hashEvidenceContent(payload);
  const withHash = { ...payload, hash };
  return { ...withHash, markdown: renderShadowReportMarkdown(withHash) };
}
