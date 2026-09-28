#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeLiveCase } from './capture-adapter.mjs';
import { newCaptureRunId } from './artifact-collector.mjs';
import { sourceMappingDigest } from './capture-transport.mjs';

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node capture-cli.mjs --config <scope.json> --case <01|20> --out <absolute-owned-root>');
  console.error('       node capture-cli.mjs --scope-hash <scope.json>');
  process.exitCode = 2;
}

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--config', '--case', '--out', '--scope-hash'].includes(key)) throw new Error(`unknown argument: ${key}`);
    if (result[key]) throw new Error(`duplicate argument: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    result[key] = value;
  }
  return result;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try { args = parse(argv); } catch (error) { usage(error.message); return 2; }
  if (args['--scope-hash']) {
    if (Object.keys(args).length !== 1) { usage('--scope-hash cannot be combined with capture arguments'); return 2; }
    const config = JSON.parse(await readFile(resolve(args['--scope-hash']), 'utf8'));
    console.log(sourceMappingDigest(config));
    return 0;
  }
  if (!args['--config'] || !args['--case'] || !args['--out'] || Object.keys(args).length !== 3) {
    usage();
    return 2;
  }
  const config = JSON.parse(await readFile(resolve(args['--config']), 'utf8'));
  const captureRunId = newCaptureRunId();
  const runRoot = resolve(args['--out'], captureRunId);
  const result = await executeLiveCase({
    config: { ...config, captureRunId },
    caseId: args['--case'],
    runRoot,
    env,
  });
  console.log(JSON.stringify({
    captureRunId,
    runRoot,
    status: result.status,
    acceptanceStatus: result.acceptanceStatus,
    reason: result.reason ?? result.acceptanceReason ?? null,
    gaps: result.gaps ?? [],
    manifestSha256: result.integrity?.manifestSha256 ?? null,
  }, null, 2));
  if (result.status === 'CAPTURE_COMPLETE') return 0;
  if (result.status === 'CAPTURE_UNCERTAIN') return 3;
  if (result.status === 'CAPTURE_INCOMPLETE') return 4;
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
