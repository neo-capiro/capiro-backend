#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNewsletterLoopbackServing } from './lib/newsletter-loopback-serving.mjs';

export function parseNewsletterLoopbackInvocation(args) {
  const accepted = new Map([['--loopback-origin', 'origin'], ['--expected-artifact', 'expectedArtifact'], ['--artifact-pins', 'artifactPins']]);
  const result = {};
  if (!Array.isArray(args) || args.length !== 6) throw new Error('Expected explicit --loopback-origin, --expected-artifact JSON and --artifact-pins JSON');
  for (let index = 0; index < args.length; index += 2) {
    const key = accepted.get(args[index]);
    if (!key || Object.hasOwn(result, key) || typeof args[index + 1] !== 'string') throw new Error('Unknown/duplicate loopback argument');
    result[key] = key === 'origin' ? args[index + 1] : JSON.parse(args[index + 1]);
  }
  return result;
}
export async function runNewsletterLoopbackOperator(args, { verify = verifyNewsletterLoopbackServing, output = console.log } = {}) {
  const receipt = await verify(parseNewsletterLoopbackInvocation(args));
  output(JSON.stringify(receipt, null, 2));
  return receipt.status === 'PASS' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNewsletterLoopbackOperator(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(JSON.stringify({ status: 'FAIL', phase: 'operator-input-or-transport',
      localServingVerified: false, publicOriginVerified: false, error: String(error.message).slice(0, 300) }));
    process.exitCode = 1;
  });
}
