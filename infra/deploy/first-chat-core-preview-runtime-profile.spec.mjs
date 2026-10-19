import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const buildspec = readFileSync(new URL('./first-chat-core-preview.buildspec.yml', import.meta.url), 'utf8');
const preparer = readFileSync(new URL('./prepare-first-chat-core-source.mjs', import.meta.url), 'utf8');
const lines = buildspec.split(/\r?\n/).map(line => line.slice(8));
const start = lines.indexOf('stage=image-architecture');
const end = lines.indexOf('docker push "$IMAGE"');
assert.ok(start >= 0 && end > start);
const publicationGates = lines.slice(start, end + 1).join('\n');

// Execute only the actual pre-push gate segment with shell-local stand-ins.
// No Docker, package, network, database or cloud command can run in this harness.
function runGates(failure = '') {
  return spawnSync('bash', ['-c', `
set -euo pipefail
IMAGE=fixture-only
docker() {
  case "$1" in
    image) printf 'amd64\\n';;
    run) printf 'smoke\\n'; test "$FAILURE" != smoke;;
    push) printf 'push\\n';;
    *) return 70;;
  esac
}
sh() {
  case "$1" in
    apps/api/scripts/qualification/run-alpine-amd64-runtime-probes.sh)
      printf 'native\\n'; test "$FAILURE" != native;;
    apps/api/scripts/qualification/run-alpine-amd64-entrypoint-db-gate.sh)
      printf 'entrypoint\\n'; test "$FAILURE" != entrypoint;;
    *) return 71;;
  esac
}
${publicationGates}
`], { encoding: 'utf8', env: { ...process.env, FAILURE: failure } });
}

test('sealed context and CodeBuild select the existing AMD64 qualification recipe', () => {
  const recipe = 'apps/api/Dockerfile.alpine-amd64-qualification';
  assert.ok(preparer.includes(`const dockerfilePath = '${recipe}'`));
  assert.ok(preparer.includes("'docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json'"));
  assert.ok(preparer.includes('`${ref}:${dockerfilePath}`'), 'COPY validation and recipe hash use selected Git blob');
  assert.ok(buildspec.includes(`-f ${recipe} -t "$IMAGE" .`));
  assert.doesNotMatch(buildspec, /--target\s+runtime-base|--build-arg|SKIP.*(?:PROBE|GATE)/);
});

test('publication follows smoke, native operations and isolated real-entrypoint gates', () => {
  const result = runGates();
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, 'smoke\nnative\nentrypoint\npush\n');
});

for (const gate of ['smoke', 'native', 'entrypoint']) {
  test(`a failed ${gate} gate prevents publication`, () => {
    const result = runGates(gate);
    assert.notEqual(result.status, 0);
    assert.ok(result.stdout.includes(`${gate}\n`));
    assert.ok(!result.stdout.includes('push\n'));
  });
}
