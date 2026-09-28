import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCanaryReport, readCanaryEvents } from '../src';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const events = argument('--events');
  const out = argument('--out');
  if (!events || !out) throw new Error('--events <jsonl> and --out <dir> are required');
  const current = readCanaryEvents(path.resolve(events));
  const baselinePath = argument('--baseline');
  const baseline = baselinePath
    ? readCanaryEvents(path.resolve(baselinePath))
    : { events: [], rejected: 0, unrelated: 0 };
  const limitsVersion = argument('--limits-version');
  if (limitsVersion !== 'v1' && limitsVersion !== 'v2') {
    throw new Error('--limits-version <v1|v2> is required');
  }
  const report = buildCanaryReport(current.events, baseline.events, { limitsVersion });
  const output = path.resolve(out);
  mkdirSync(output, { recursive: true });
  const { markdown, ...json } = report;
  writeFileSync(path.join(output, 'canary-report.json'), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(path.join(output, 'canary-report.md'), markdown);
  console.log(
    `Wrote ${output} (${report.hash}); ${current.events.length} canary, ${baseline.events.length} baseline, ${current.rejected + baseline.rejected} rejected`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
