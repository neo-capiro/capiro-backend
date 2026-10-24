import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const buildspec = readFileSync(
  new URL('./first-chat-core-preview.buildspec.yml', import.meta.url),
  'utf8',
);
const lines = buildspec.split(/\r?\n/);
const first = lines.findIndex((line) => line.trim() === 'stage=source-pin');
const last = lines.findIndex((line) => line.trim() === 'stage=repository-mutability');
assert.ok(first >= 0 && last > first, 'source pin stages exist in buildspec');
const sourceGuards = lines.slice(first, last).map((line) => line.slice(8)).join('\n');
const script = lines.slice(lines.findIndex((line) => line.trim() === 'set -euo pipefail')).map((line) => line.slice(8)).join('\n');

// Test values are syntactically valid but are not an approved build source.
const bucket = 'capiro-portfolio-preview-source-967807252336-us-east-1';
const sourceSha = 'a'.repeat(40);
const key = `inputs/core-${sourceSha}.zip`;
const version = 'V1.x_y-123+/=';
const archiveSha256 = 'b'.repeat(64);

function checkSourceGuards(overrides = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nREPOSITORY=capiro/preview-core\nREGISTRY=967807252336.dkr.ecr.us-east-1.amazonaws.com\n${sourceGuards}\nprintf '%s|%s|%s|%s' "$SOURCE_SHA" "$SOURCE_KEY" "$ARCHIVE_SHA256" "$IMAGE"`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APPROVED_SOURCE_BUCKET: bucket,
      APPROVED_SOURCE_SHA: sourceSha,
      APPROVED_SOURCE_VERSION_ID: version,
      APPROVED_ARCHIVE_SHA256: archiveSha256,
      CODEBUILD_SOURCE_VERSION: version,
      CODEBUILD_RESOLVED_SOURCE_VERSION: '',
      ...overrides,
    },
  });
}

test('the complete embedded build script parses without running it', () => {
  const result = spawnSync('bash', ['-n', '-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('native ARM recipe, runtime probes and archive inputs agree before any push', () => {
  assert.match(buildspec, /test "\$\(uname -m\)" = aarch64/);
  assert.match(buildspec, /docker build --pull --platform linux\/arm64 --target runtime/);
  assert.match(buildspec, /-f apps\/api\/Dockerfile\.alpine-qualification/);
  assert.match(buildspec, /\}\}'\)" = arm64/);
  const probe = buildspec.indexOf('sh apps/api/scripts/qualification/run-alpine-runtime-probes.sh "$IMAGE"');
  assert(probe > 0 && probe < buildspec.indexOf('docker push "$IMAGE"'));
  assert.doesNotMatch(buildspec, /linux\/amd64|x86_64|process\.arch,'x64'/);
  const preparer = readFileSync(new URL('./prepare-first-chat-core-source.mjs', import.meta.url), 'utf8');
  assert.match(preparer, /'apps\/api\/Dockerfile\.alpine-qualification'/);
  assert.match(preparer, /'docs\/runtime-production-closure-20261014\/RUNTIME-CLOSURE-CONTRACT\.json'/);
  assert.doesNotMatch(preparer, /'apps\/api\/Dockerfile'|\$\{ref\}:apps\/api\/Dockerfile`/);
});

test('reviewed project pins select one derived archive key and immutable image tag', () => {
  assert.match(buildspec, /SOURCE_KEY="inputs\/core-\$SOURCE_SHA\.zip"/);
  assert.match(buildspec, /aws s3api get-object --bucket "\$APPROVED_SOURCE_BUCKET" --key "\$SOURCE_KEY" --version-id "\$APPROVED_SOURCE_VERSION_ID"/);
  assert.match(buildspec, /test "\$observed_version" = "\$APPROVED_SOURCE_VERSION_ID"/);
  assert.match(buildspec, /sha256sum -c -/);
  assert.match(buildspec, /test -z "\$\{CODEBUILD_RESOLVED_SOURCE_VERSION:-\}"/);
  assert.match(buildspec, /test -f apps\/api\/prisma\/reserved-migrations\/20281018060000_meri_read_delegation\/migration\.sql/);
  assert.doesNotMatch(buildspec, /objective-migration-absence|SOURCE_SHA=13d12a7d7/);

  for (const metadataUrl of [`s3://${bucket}/${key}`, `${bucket}/${key}`]) {
    const result = checkSourceGuards({ CODEBUILD_SOURCE_REPO_URL: metadataUrl });
    assert.equal(result.status, 0, JSON.stringify({ stderr: result.stderr, stdout: result.stdout, error: result.error?.message }));
    assert.equal(result.stdout, `${sourceSha}|${key}|${archiveSha256}|967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core:${sourceSha}`);
  }
});

test('source pin refuses invalid or missing project pins and changed build source metadata', () => {
  for (const changed of [
    { APPROVED_SOURCE_SHA: 'wrong-branch' },
    { APPROVED_SOURCE_SHA: sourceSha.toUpperCase() },
    { APPROVED_SOURCE_SHA: '' },
    { APPROVED_ARCHIVE_SHA256: 'wrong-hash' },
    { APPROVED_ARCHIVE_SHA256: '' },
    { APPROVED_SOURCE_BUCKET: 'other-bucket' },
    { APPROVED_SOURCE_VERSION_ID: '' },
    { APPROVED_SOURCE_VERSION_ID: 'version with space' },
    { APPROVED_SOURCE_VERSION_ID: 'different-version' },
    { CODEBUILD_SOURCE_VERSION: 'different-version' },
    { CODEBUILD_RESOLVED_SOURCE_VERSION: 'unexpected' },
  ]) {
    assert.notEqual(checkSourceGuards(changed).status, 0, JSON.stringify(changed));
  }
});
