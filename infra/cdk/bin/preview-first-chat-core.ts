#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  previewFirstChatCoreApplication,
  previewFirstChatCoreRegistryApplication,
} from '../lib/preview/first-chat-core';

const usage =
  'Usage: preview-first-chat-core --render-registry <fresh-output-directory> | --render <image-binding.json> <fresh-output-directory> | --help';

/** Renders a source proposal. No AWS call, task, migration, or image build. */
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  if (
    !(
      (args.length === 2 && args[0] === '--render-registry') ||
      (args.length === 3 && args[0] === '--render')
    )
  ) {
    console.error(usage);
    return 2;
  }
  try {
    const registryOnly = args[0] === '--render-registry';
    const output = path.resolve(args[registryOnly ? 1 : 2]!);
    if (fs.lstatSync(output, { throwIfNoEntry: false }) !== undefined) {
      throw new Error('Fresh output directory required');
    }
    let app;
    if (registryOnly) {
      ({ app } = previewFirstChatCoreRegistryApplication(output));
    } else {
      const input = path.resolve(args[1]!);
      const stat = fs.lstatSync(input);
      if (
        path.extname(input) !== '.json' ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096
      ) {
        throw new Error('Bounded image binding required');
      }
      ({ app } = previewFirstChatCoreApplication(
        JSON.parse(fs.readFileSync(input, 'utf8')),
        output,
      ));
    }
    app.synth();
    console.log('Rendered first-chat Core source only. No AWS operation performed.');
    return 0;
  } catch {
    console.error('First-chat Core rendering refused; invalid binding, output, or source');
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
