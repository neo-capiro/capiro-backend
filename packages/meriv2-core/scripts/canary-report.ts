/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCanaryReport, readCanaryEvents } from '../src';

const usage =
  'Usage: tsx scripts/canary-report.ts --events <jsonl> --out <dir> --limits-version <v1|v2> [--baseline <jsonl>]';

function guardCli(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(usage);
    process.exit(2);
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  const valued = new Set(['--events', '--out', '--limits-version', '--baseline']);
  for (let index = 0; index < args.length; index += 1) {
    if (!valued.has(args[index]!) || index + 1 >= args.length) {
      console.error(usage);
      process.exit(2);
    }
    index += 1;
  }
}

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
  guardCli();
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
