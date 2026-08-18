#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const base = process.argv[2] || 'origin/main';

const IMPLEMENTATION_PREFIXES = [
  'apps/api/src/context/',
  'apps/api/src/retrieval/',
  'packages/meriv2-core/src/context/',
];

const TEST_SUFFIXES = ['.spec.ts', '.test.ts'];

/**
 * Product code must consume ContextPlaneGatewayService, not reach through the
 * gateway to individual resolver/compiler/retrieval implementations. Existing
 * legacy imports are grandfathered because this guard inspects ADDED lines only;
 * adding a new bypass after Phase 18 fails CI.
 */
const BANNED_ADDITION_PATTERNS = [
  /context-compiler\.service/,
  /context-packet-v2\.service/,
  /context-resolver\.service/,
  /retrieval-v2\.service/,
  /\bContextCompilerService\b/,
  /\bContextPacketV2Service\b/,
  /\bContextResolverService\b/,
  /\bRetrievalV2Service\b/,
  /\bContextPacketRolloutCompiler\b/,
  /\bTruthfulContextCompiler\b/,
  /\bcompileCoverageAwareContextPacket\b/,
  /\bresolveTenantContextPacketMode\b/,
  /\bresolveContextPacketMode\b/,
];

let diff = '';
try {
  diff = execFileSync(
    'git',
    [
      'diff',
      '--unified=0',
      '--no-color',
      `${base}...HEAD`,
      '--',
      ':(glob)**/*.ts',
      ':(glob)**/*.tsx',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
} catch (error) {
  console.error(`Context Plane guard could not diff against ${base}.`);
  throw error;
}

const violations = [];
let file = null;
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) {
    file = line.slice('+++ b/'.length);
    continue;
  }
  if (!file || !line.startsWith('+') || line.startsWith('+++')) continue;
  if (IMPLEMENTATION_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
  if (TEST_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;

  const added = line.slice(1);
  const matched = BANNED_ADDITION_PATTERNS.find((pattern) => pattern.test(added));
  if (matched) violations.push({ file, added: added.trim(), pattern: String(matched) });
}

if (violations.length > 0) {
  console.error('\nContext Plane architecture violation: new feature code bypasses the Phase 18 gateway.');
  console.error('Use ContextPlaneGatewayService. A genuine exception requires an explicit reviewed architecture change.\n');
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.added}`);
  }
  process.exit(1);
}

console.log('Context Plane architecture guard: no new direct resolver/compiler/Retrieval V2 bypass imports.');
