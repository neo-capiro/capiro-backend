/** Manual provider-output comparison; offline mode tests contracts, never LLM quality. */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AI_PRICING, computeAiCostUsd } from '@capiro/shared';
import { buildChatSystemPrompt } from '../../meriv2-orchestrator/src/meri/chat/chat-prompt.js';
import { resolveMeriV3ReasoningProfile } from '../../meriv2-orchestrator/src/meri/meriv3/meriv3-reasoning.js';
import {
  OpenAiResponsesClient,
  readOpenAiResponsesErrorTelemetry,
} from '../../meriv2-orchestrator/src/meri/meriv3/openai-responses.client.js';
import {
  GA_FIXTURE_VERSION,
  GOVERNMENT_AFFAIRS_FIXTURES,
  governmentAffairsFixtureInput,
} from '../src/meri/evals/government-affairs-fixtures.js';
import {
  GOVERNMENT_AFFAIRS_REVIEW_RUBRIC,
  gradeGovernmentAffairsAnswer,
  scoreGovernmentAffairsHumanReview,
  type GovernmentAffairsHumanReview,
} from '../src/meri/evals/government-affairs-grader.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
function boundedOption(name: string, fallback: number, min: number, max: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

async function main(): Promise<void> {
  const scorePath = option('--score-review');
  if (scorePath) {
    const path = resolve(scorePath);
    const report = JSON.parse(readFileSync(path, 'utf8')) as {
      evaluationKind: string;
      rows: Array<{
        id: string;
        status: string;
        humanReview: GovernmentAffairsHumanReview | null;
        reviewScore?: unknown;
      }>;
    };
    if (report.evaluationKind !== 'live-provider-output-comparison')
      throw new Error('Only actual live-provider reports can receive professional review scores.');
    let reviewed = 0;
    for (const row of report.rows) {
      if (row.humanReview) {
        if (row.status !== 'completed')
          throw new Error(`Cannot grade incomplete provider result ${row.id} as completed output.`);
        row.reviewScore = scoreGovernmentAffairsHumanReview(row.humanReview);
        reviewed += 1;
      }
    }
    if (!reviewed) throw new Error('No named human reviews supplied; quality remains unmeasured.');
    const output = resolve(option('--out') ?? `${path}.reviewed.json`);
    save(output, { ...report, professionalReviewCount: reviewed, defaultModelChanged: false });
    console.log(`Scored ${reviewed} explicit human reviews: ${output}. No default model changed.`);
    return;
  }

  const live = args.includes('--live');
  const output = resolve(
    option('--out') ?? `eval-results/meri-government-affairs-${live ? 'live' : 'contract'}.json`,
  );
  if (!live) {
    const rows = GOVERNMENT_AFFAIRS_FIXTURES.map((fixture) => ({
      id: fixture.id,
      grade: gradeGovernmentAffairsAnswer(fixture, fixture.referenceAnswer),
    }));
    save(output, {
      evaluationKind: 'offline-fixture-contract-check',
      fixtureVersion: GA_FIXTURE_VERSION,
      providerCalls: 0,
      professionalQualityMeasured: false,
      defaultModelChanged: false,
      rows,
    });
    console.log(
      `Fixture contract checks ${rows.filter((row) => row.grade.pass).length}/${rows.length}: ${output}. No provider output evaluated.`,
    );
    if (rows.some((row) => !row.grade.pass)) process.exitCode = 1;
    return;
  }

  if (!process.env.OPENAI_API_KEY)
    throw new Error(
      'Live evaluation requires the existing account OPENAI_API_KEY; no provider call made.',
    );
  if (!process.env.MERIV3_MAX_MODEL?.trim())
    throw new Error(
      'Set MERIV3_MAX_MODEL to an account-available comparison candidate. The harness cannot infer the strongest available model.',
    );
  const samples = boundedOption('--samples', 1, 1, 3);
  const maxOutputTokens = boundedOption('--max-output-tokens', 4_096, 1_024, 8_192);
  const timeoutMs = boundedOption('--timeout-ms', 120_000, 15_000, 300_000);
  const totalBudgetMs = boundedOption('--total-budget-ms', 1_200_000, 30_000, 1_800_000);
  const profiles = [
    resolveMeriV3ReasoningProfile('standard'),
    { ...resolveMeriV3ReasoningProfile('deep'), effort: 'high' as const },
    resolveMeriV3ReasoningProfile('max'),
  ].map((profile) => ({ ...profile, maxOutputTokens, turnBudgetMs: timeoutMs }));
  const instructions = buildChatSystemPrompt(
    { clientId: 'eval-client-arbor' },
    {
      tenantId: 'eval-synthetic-tenant',
      userId: 'eval-synthetic-user',
      clerkUserId: 'eval-synthetic-clerk',
      role: 'standard_user',
    },
  );
  const report = {
    evaluationKind: 'live-provider-output-comparison',
    fixtureVersion: GA_FIXTURE_VERSION,
    startedAt: new Date().toISOString(),
    promptSha256: digest(instructions),
    comparisonScope:
      'Same supplied synthetic evidence through production chat prompt and Responses client; retrieval, UI and durable research are separate release checks.',
    strongestAccountOptionVerified: false,
    candidateSelection:
      'Standard production configuration; Deep with high effort; explicit configured Max-slot candidate. Availability is established only by successful provider calls, not model naming.',
    outputTokenCeiling: maxOutputTokens,
    timeoutMs,
    totalBudgetMs,
    samples,
    profiles,
    rubric: GOVERNMENT_AFFAIRS_REVIEW_RUBRIC,
    scoreAnchors: {
      0: 'absent or materially wrong',
      1: 'major rework',
      2: 'usable with corrections',
      3: 'professional with minor corrections',
      4: 'decision-ready and supported',
    },
    defaultModelChanged: false,
    modelRecommendation: null,
    rows: [] as Array<Record<string, unknown>>,
  };
  const provider = new OpenAiResponsesClient();
  const controller = new AbortController();
  const deadlineAt = Date.now() + totalBudgetMs;
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  save(output, report);
  try {
    for (let sample = 0; sample < samples; sample += 1) {
      for (const [fixtureIndex, fixture] of GOVERNMENT_AFFAIRS_FIXTURES.entries()) {
        // Rotate profile order across tasks/samples to reduce a fixed ordering effect.
        for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
          if (controller.signal.aborted || Date.now() >= deadlineAt) {
            save(output, { ...report, stopped: true, finishedAt: new Date().toISOString() });
            process.exitCode = 1;
            return;
          }
          const profile = profiles[(profileIndex + fixtureIndex + sample) % profiles.length]!;
          const id = `${fixture.id}:${profile.mode}:${sample + 1}`;
          const input = governmentAffairsFixtureInput(fixture);
          const startedAt = Date.now();
          let row: Record<string, unknown>;
          try {
            const result = await provider.complete({
              profile,
              instructions,
              input: [{ role: 'user', content: input }],
              tools: [],
              toolChoice: 'none',
              timeoutMs,
              deadlineAt,
              signal: controller.signal,
            });
            const price =
              AI_PRICING[result.model] ?? AI_PRICING[result.model.replace(/-\d{8}$/, '')];
            const complete =
              !result.telemetry.partial &&
              result.status === 'completed' &&
              result.outputText.length > 0 &&
              result.functionCalls.length === 0;
            row = {
              id,
              fixtureId: fixture.id,
              skill: fixture.skill,
              sample: sample + 1,
              mode: profile.mode,
              status: complete ? 'completed' : 'partial',
              inputSha256: digest(input),
              providerResponseId: result.id,
              telemetry: result.telemetry,
              providerCalls: result.providerCalls ?? [result.telemetry],
              latencyMs: Date.now() - startedAt,
              usage: result.usage,
              estimatedCostUsd: price
                ? computeAiCostUsd(
                    result.model,
                    result.usage.inputTokens,
                    result.usage.outputTokens,
                  )
                : null,
              costBasis: price
                ? 'Existing repository list-price estimate; provider bill not supplied; cache discounts not applied.'
                : 'No configured price for effective model; cost unknown.',
              actualBilledCostUsd: null,
              answer: result.outputText,
              contractGrade: gradeGovernmentAffairsAnswer(fixture, result.outputText),
              reviewChecks: fixture.reviewChecks,
              humanReview: null,
              reviewScore: null,
            };
          } catch (error) {
            row = {
              id,
              fixtureId: fixture.id,
              skill: fixture.skill,
              sample: sample + 1,
              mode: profile.mode,
              status: controller.signal.aborted ? 'cancelled' : 'error',
              inputSha256: digest(input),
              requestedModel: profile.model,
              requestedReasoningEffort: profile.effort,
              telemetry: readOpenAiResponsesErrorTelemetry(error) ?? null,
              // Error messages can contain provider/request information; never persist them.
              errorType: error instanceof Error ? error.name : 'UnknownError',
              latencyMs: Date.now() - startedAt,
              usage: null,
              estimatedCostUsd: null,
              actualBilledCostUsd: null,
              humanReview: null,
              reviewScore: null,
            };
          }
          report.rows.push(row);
          save(output, report);
          console.log(`${id}: ${row.status}`);
        }
      }
    }
    save(output, { ...report, finishedAt: new Date().toISOString() });
    console.log(
      `Provider comparison saved: ${output}. Professional quality awaits human review; no default changed.`,
    );
    if (report.rows.some((row) => row.status !== 'completed')) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Evaluation failed.');
  process.exitCode = 1;
});
