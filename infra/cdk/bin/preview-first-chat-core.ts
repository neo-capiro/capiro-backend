#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  firstChatCoreIntegrationsConfiguration,
  previewFirstChatCoreApplication,
} from '../lib/preview/first-chat-core';
import { previewFirstChatEdgeApplication } from '../lib/preview/first-chat-preview-edge';

const usage =
  'Usage: preview-first-chat-core --render <image-binding.json> <fresh-output-directory> | --render-integrations <integration-binding.json> <fresh-output.json> | --render-edge <fresh-output-directory> | --render-edge-with-dns <fresh-output-directory> | --help';

/** Renders a source proposal. No AWS call, task, migration, or image build. */
export function main(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  if (args.length === 2 && ['--render-edge', '--render-edge-with-dns'].includes(args[0]!)) {
    try {
      const output = path.resolve(args[1]!);
      if (fs.lstatSync(output, { throwIfNoEntry: false }) !== undefined)
        throw new Error('Fresh output directory required');
      previewFirstChatEdgeApplication(output, args[0] === '--render-edge-with-dns').app.synth();
      console.log(
        'Rendered dedicated preview edge only. Apply DNS last. No AWS operation performed.',
      );
      return 0;
    } catch {
      console.error('Preview edge rendering refused; invalid output or source');
      return 2;
    }
  }
  if (args.length !== 3 || !['--render', '--render-integrations'].includes(args[0]!)) {
    console.error(usage);
    return 2;
  }
  try {
    const output = path.resolve(args[2]!);
    if (fs.lstatSync(output, { throwIfNoEntry: false }) !== undefined) {
      throw new Error('Fresh output directory required');
    }
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
    const binding: unknown = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (args[0] === '--render-integrations') {
      if (path.extname(output) !== '.json') throw new Error('JSON output required');
      const configuration = firstChatCoreIntegrationsConfiguration(binding);
      fs.writeFileSync(output, JSON.stringify(configuration, null, 2) + '\n', { flag: 'wx' });
      console.log('Rendered preview integration overlay only. No AWS operation performed.');
      return 0;
    }
    const { app } = previewFirstChatCoreApplication(binding, output);
    app.synth();
    console.log('Rendered first-chat Core source only. No AWS operation performed.');
    return 0;
  } catch {
    console.error('First-chat Core rendering refused; invalid binding, output, or source');
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
