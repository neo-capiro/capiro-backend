/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEvalCli } from './lib/eval-cli';
import type { JevChoiceTaskDecision, JevTaskEvaluationCase } from '../src';

const cli = parseEvalCli({
  usage:
    'Usage: tsx scripts/jev-package2-eval.ts --write [--fixture FILE] [--output DIR] (or provide --fixture/--output explicitly)',
  valueOptions: ['--fixture', '--output'],
  actionOptions: ['--write'],
});

async function main(): Promise<void> {
  const { JEV_TASK_REGISTRY, jevTaskEvaluationFixtureSchema, runJevTaskPairedEvaluation } =
    await import('../src');
  const fixturePath = path.resolve(
    cli.values.get('--fixture') ??
      path.join(__dirname, '../src/jev/__fixtures__/package2-task-evaluation-v1.json'),
  );
  const outputDir = path.resolve(cli.values.get('--output') ?? 'tmp/jev-package2-eval');
  const fixture = jevTaskEvaluationFixtureSchema.parse(
    JSON.parse(readFileSync(fixturePath, 'utf8')),
  );
  const byId = new Map(fixture.cases.map((item) => [item.id, item]));
  const cases: JevTaskEvaluationCase[] = fixture.cases.map(
    ({ id, task, category, expected, humanReview }) => ({
      id,
      task,
      category,
      expected,
      humanReview,
    }),
  );
  const replay =
    (provider: 'jev' | 'baseline') =>
    async (item: JevTaskEvaluationCase): Promise<JevChoiceTaskDecision> => {
      const observed = byId.get(item.id)!.replay[provider];
      const metadata = {
        name: `fixture-replay:${provider}`,
        model: fixture.model,
        questionVersion: JEV_TASK_REGISTRY[item.task].questionVersion,
      };
      return observed.kind === 'failure'
        ? {
            kind: 'failure',
            task: item.task,
            state: observed.state,
            reasonCodes: [observed.state],
            provider: metadata,
            latencyMs: observed.latencyMs,
          }
        : {
            kind: 'outcome',
            task: item.task,
            outcome: observed.outcome,
            probabilities: { [observed.outcome]: 1 },
            confidence: observed.confidence,
            action: observed.action,
            reasonCodes: observed.action === 'abstain' ? ['fixture_abstention'] : [],
            evidenceIds: [],
            provider: metadata,
            latencyMs: observed.latencyMs,
            usage: observed.usage,
          };
    };
  const output = await runJevTaskPairedEvaluation({
    cases,
    providers: { jev: replay('jev'), baseline: replay('baseline') },
  });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'results.json'), `${JSON.stringify(output, null, 2)}\n`);
  const taskLines = Object.entries(output.perTask).map(([task, result]) => {
    const metrics = result.providers.jev;
    return `| ${task} | ${result.cases} | ${metrics.matchedExpected} | ${metrics.failures} | ${metrics.inputTokens} | ${metrics.outputTokens} | ${metrics.latencyMs.p95} | ${metrics.estimatedCostUsd ?? 'unpriced'} |`;
  });
  writeFileSync(
    path.join(outputDir, 'summary.md'),
    [
      '# Jev Package 2 paired replay',
      '',
      `- Fixture: ${fixture.version}`,
      `- Registry: ${fixture.registryVersion}`,
      `- Pinned model: ${fixture.model}`,
      `- Cases: ${output.totalCases}`,
      `- Output hash: \`${output.hash}\``,
      '- Label status: proposed; this report proves contract behavior, not calibrated production accuracy.',
      '- Pricing: unpriced; token and latency metrics are reported without inventing an output-token rate.',
      '',
      '| Task | Cases | Jev matched expected | Failures | Input tokens | Output tokens | p95 ms | Estimated USD |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...taskLines,
      '',
    ].join('\n'),
  );
  console.log(`Wrote ${outputDir} (${output.hash})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
