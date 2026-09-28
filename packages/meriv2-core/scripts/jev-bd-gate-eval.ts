import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bdTaskReviewFixtureSchema, evaluateBdTaskGate } from '../src';

/**
 * Offline BD task canary-gate CLI. Reads a bd_task_review_fixture_v2 fixture
 * and writes JSON + Markdown gate reports. Never contacts a provider; all
 * observations are recorded in the fixture. A synthetic pass proves gate logic
 * only — never semantic accuracy.
 */

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function main(): void {
  const fixturePath = path.resolve(argument('--fixture', ''));
  if (!fixturePath) {
    console.error('usage: tsx scripts/jev-bd-gate-eval.ts --fixture <path> [--output <dir>]');
    process.exit(2);
  }
  const outputDir = path.resolve(argument('--output', 'tmp/jev-bd-gate'));
  const fixture = bdTaskReviewFixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
  const result = evaluateBdTaskGate(fixture);
  mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, `${result.task}-gate.json`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);

  const outcomeRows = Object.keys(result.metrics.confusionMatrix).map((expected) =>
    [
      `| ${expected} | ${Object.values(result.metrics.confusionMatrix[expected]!)
        .map((n) => n)
        .join(' | ')} |`,
    ].join('\n'),
  );
  const stratumLines = (
    title: string,
    breakdown: Record<string, { count: number; errors: number }>,
  ) => [
    `### ${title}`,
    '',
    '| Key | Cases | Errors |',
    '| --- | ---: | ---: |',
    ...Object.keys(breakdown)
      .sort()
      .map((key) => `| ${key} | ${breakdown[key]!.count} | ${breakdown[key]!.errors} |`),
    '',
  ];
  const md = [
    `# BD canary gate — ${result.task}`,
    '',
    `- Fixture: ${fixture.version} (${path.basename(fixturePath)})`,
    `- Registry: ${result.registryVersion} (fixture pinned ${fixture.pinned.registryVersion})`,
    `- Approved (reviewed) cases: ${result.metrics.reviewedCases}`,
    `- Proposed (unreviewed, never counted) cases: ${result.metrics.proposedCases}`,
    `- Gate result: ${result.approved ? 'PASS' : 'FAIL'}`,
    `- Authorization: ${result.authorization}`,
    '',
    'This is an offline gate evaluation over recorded observations. It proves gate logic and',
    'metric computation only; it is not evidence of semantic accuracy, and it does not change',
    'the task registry: BD-ENTITY and BD-SIGNAL remain shadow/proposed.',
    '',
    '## Reasons',
    ...(result.reasons.length ? result.reasons.map((r) => `- ${r}`) : ['- none']),
    '',
    '## Confusion matrix (expected × observed)',
    '',
    `| expected \\ observed | ${Object.keys(result.metrics.confusionMatrix[Object.keys(result.metrics.confusionMatrix)[0]!] ?? { a: 0 }).join(' | ')} |`,
    '| --- | ' +
      Object.keys(
        result.metrics.confusionMatrix[Object.keys(result.metrics.confusionMatrix)[0]!] ?? { a: 0 },
      )
        .map(() => '---:')
        .join(' | ') +
      ' |',
    ...outcomeRows,
    '',
    '## Precision / recall',
    '',
    '| Outcome | Precision | Recall |',
    '| --- | ---: | ---: |',
    ...Object.keys(result.metrics.perOutcomePrecision).map(
      (outcome) =>
        `| ${outcome} | ${result.metrics.perOutcomePrecision[outcome]!.toFixed(3)} | ${result.metrics.perOutcomeRecall[outcome]!.toFixed(3)} |`,
    ),
    '',
    '## Operational metrics',
    '',
    `- Abstain share: ${(result.metrics.abstainShare * 100).toFixed(1)}%`,
    `- Review-required share: ${(result.metrics.reviewShare * 100).toFixed(1)}% (recorded human-review-required share of approved cases; ceiling ${(fixture.thresholds.maxReviewShare * 100).toFixed(1)}%)`,
    `- Severe errors: ${result.metrics.severeErrors.length}`,
    `- Latency p50/p95: ${result.metrics.latencyMs.p50}ms / ${result.metrics.latencyMs.p95}ms (ceilings ${fixture.ceilings.maxMedianLatencyMs}ms / ${fixture.ceilings.maxP95LatencyMs}ms)`,
    `- Tokens: ${result.metrics.tokens.input} in / ${result.metrics.tokens.output} out`,
    `- Estimated Jev cost: ${result.metrics.estimatedCostUsd === null ? 'unpriced' : `$${result.metrics.estimatedCostUsd.toFixed(6)}`} (ceiling $${fixture.ceilings.maxEstimatedCostUsd}; approved public price $0.042/M input, output free)`,
    '',
    ...stratumLines('By source family', result.metrics.strata.sourceFamily),
    ...stratumLines('By sector', result.metrics.strata.sector),
    ...stratumLines('By company size', result.metrics.strata.companySize),
    ...stratumLines('By task category', result.metrics.strata.taskCategory),
    ...stratumLines('By source availability', result.metrics.strata.sourceAvailability),
  ].join('\n');
  writeFileSync(path.join(outputDir, `${result.task}-gate.md`), `${md}\n`);
  console.log(
    `Gate ${result.approved ? 'PASS' : 'FAIL'} for ${result.task}; reports in ${outputDir}`,
  );
  if (!result.approved) {
    for (const reason of result.reasons) console.error(`reason: ${reason}`);
    process.exit(1);
  }
}

main();
