#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previewForecastsOperationsApplication } from '../lib/preview/forecasts-operations';

const usage =
  'Usage: preview-forecasts-operations --render <forecasts-binding.json> <fresh-output-directory>\n' +
  'Renders Capiro-Preview-Government-Forecasts (task definition, archive, staging, disabled daily rule, alarms) from a bounded binding. No AWS call.';

/** Renders a source proposal. No AWS call, task, migration or image build. */
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  if (args.length !== 3 || args[0] !== '--render') {
    console.error(usage);
    return 2;
  }
  try {
    const output = path.resolve(args[2]!);
    if (fs.lstatSync(output, { throwIfNoEntry: false }) !== undefined) throw new Error('Fresh output directory required');
    const input = path.resolve(args[1]!);
    const stat = fs.lstatSync(input);
    if (path.extname(input) !== '.json' || !stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Bounded binding required');
    const binding: unknown = JSON.parse(fs.readFileSync(input, 'utf8'));
    previewForecastsOperationsApplication(binding, output).app.synth();
    console.log('Rendered the government-forecasts operations stack only. No AWS operation performed.');
    return 0;
  } catch {
    console.error('Forecasts operations rendering refused; invalid binding, output or source');
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
