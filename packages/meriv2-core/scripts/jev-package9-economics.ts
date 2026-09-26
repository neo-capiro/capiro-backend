import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runJevPackage9Economics } from '../src/jev/evaluation/package9-economics';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const fixturePath = path.resolve(argument('--fixture', path.join(__dirname, '../src/jev/__fixtures__/package9-economics-proposed-v1.json')));
const outputPath = path.resolve(argument('--output', 'tmp/jev-package9-economics/report.json'));
const report = runJevPackage9Economics(JSON.parse(readFileSync(fixturePath, 'utf8')));
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.decision}: ${report.blockers.join(', ') || 'qualification criteria met'} (${report.hash})`);
