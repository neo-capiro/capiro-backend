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

const bucket = 'capiro-portfolio-preview-source-967807252336-us-east-1';
const key = 'inputs/core-13d12a7d7bdbe0be021cb218dd4cf7690cc4420b.zip';
const version = 'H7novBkHZg.qAof.Kf5GRr_joZfnzOHx';
const archiveSha256 = '8643d671d641fb6379c442931e2ed953c2654b418580e7274116d2e4c4d68b16';

function checkSourceGuards(overrides = {}) {
  return spawnSync('bash', ['-c', `set -euo pipefail\n${sourceGuards}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APPROVED_SOURCE_BUCKET: bucket,
      APPROVED_SOURCE_VERSION_ID: version,
      CODEBUILD_SOURCE_VERSION: version,
      CODEBUILD_RESOLVED_SOURCE_VERSION: '',
      ...overrides,
    },
  });
}

test('both documented S3 URL and observed ProjectSource location retain the exact source pin', () => {
  assert.match(buildspec, new RegExp(`^        SOURCE_KEY=${key.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(buildspec, new RegExp(`^        ARCHIVE_SHA256=${archiveSha256}$`, 'm'));
  assert.match(buildspec, /aws s3api get-object --bucket "\$APPROVED_SOURCE_BUCKET" --key "\$SOURCE_KEY" --version-id "\$APPROVED_SOURCE_VERSION_ID"/);
  assert.match(buildspec, /sha256sum -c -/);

  for (const metadataUrl of [`s3://${bucket}/${key}`, `${bucket}/${key}`]) {
    const result = checkSourceGuards({ CODEBUILD_SOURCE_REPO_URL: metadataUrl });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('source pin rejects changed bucket, version and build source version', () => {
  for (const changed of [
    { APPROVED_SOURCE_BUCKET: 'other-bucket' },
    { APPROVED_SOURCE_VERSION_ID: 'other-version' },
    { CODEBUILD_SOURCE_VERSION: 'other-version' },
    { CODEBUILD_RESOLVED_SOURCE_VERSION: 'unexpected' },
  ]) {
    assert.notEqual(checkSourceGuards(changed).status, 0, JSON.stringify(changed));
  }
});
