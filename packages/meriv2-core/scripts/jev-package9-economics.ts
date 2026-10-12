/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEvalCli } from './lib/eval-cli';

const cli = parseEvalCli({
  usage:
    'Usage: tsx scripts/jev-package9-economics.ts --write [--fixture FILE] [--output FILE] (or provide --fixture/--output explicitly)',
  valueOptions: ['--fixture', '--output'],
  actionOptions: ['--write'],
});

async function main(): Promise<void> {
  const { runJevPackage9Economics } = await import('../src/jev/evaluation/package9-economics');
  const fixturePath = path.resolve(
    cli.values.get('--fixture') ??
      path.join(__dirname, '../src/jev/__fixtures__/package9-economics-proposed-v1.json'),
  );
  const outputPath = path.resolve(
    cli.values.get('--output') ?? 'tmp/jev-package9-economics/report.json',
  );
  const report = runJevPackage9Economics(JSON.parse(readFileSync(fixturePath, 'utf8')));
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `${report.decision}: ${report.blockers.join(', ') || 'qualification criteria met'} (${report.hash})`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
