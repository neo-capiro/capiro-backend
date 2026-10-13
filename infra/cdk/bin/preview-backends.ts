#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previewBindings } from '../lib/preview/bindings';
import { previewBackendApplication } from '../lib/preview/application';

const usage =
  'Usage: preview-backends --render <public-bindings.json> <fresh-output-directory> | --help';
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
    const input = path.resolve(args[1]!),
      output = path.resolve(args[2]!);
    const stat = fs.lstatSync(input);
    if (
      path.extname(input) !== '.json' ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 32768 ||
      fs.existsSync(output)
    )
      throw new Error('Bounded public metadata and fresh output directory required');
    const bindings = previewBindings(JSON.parse(fs.readFileSync(input, 'utf8')));
    const { app } = previewBackendApplication(bindings, output);
    app.synth();
    console.log(
      'Rendered source proposal only; services held at zero. No AWS operation performed.',
    );
    return 0;
  } catch {
    console.error('Preview rendering refused; invalid bindings, output or source configuration');
    return 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
