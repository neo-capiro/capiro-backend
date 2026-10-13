import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = '0a76666dc57aa852586c35167426a540939c9918';
const read = file => readFileSync(path.join(ROOT, file), 'utf8');
const digest = text => createHash('sha256').update(text).digest('hex');
const DOCKER = read('apps/web/Dockerfile.frontend-artifact');
const RUNTIME = `FROM base AS runtime
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
COPY --from=artifact-check --chown=node:node /workspace/release-artifacts/capiro-frontend/rootfs ./
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
`;
const BASE_PROFILE = `FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS base
RUN apk add --no-cache --upgrade zlib=1.3.2-r1 ca-certificates
WORKDIR /app
`;

function validate(source) {
  assert.equal(source.split(BASE_PROFILE).length, 2, 'frontend runtime base profile');
  assert.equal(source.slice(source.indexOf('FROM base AS runtime')), RUNTIME, 'frontend runtime projection');
  assert.equal((source.match(/^FROM /gm) ?? []).length, 3);
  for (const suffix of ['MANIFEST_SHA256', 'SOURCE_REPOSITORY', 'SOURCE_COMMIT']) {
    assert.match(source, new RegExp(`^ARG FRONTEND_ARTIFACT_${suffix}$`, 'm'));
    assert.match(source, new RegExp(`"\\$FRONTEND_ARTIFACT_${suffix}"`));
  }
  assert.match(source, /^COPY release-artifacts\/capiro-frontend release-artifacts\/capiro-frontend$/m);
  assert.match(source, /--artifact-dir \/workspace\/release-artifacts\/capiro-frontend/);
  assert.match(source, /--manifest-sha256 /);
  assert.match(source, /--source-repository /);
  assert.match(source, /--source-commit /);
  assert.match(source, /^ARG TARGETPLATFORM$/m);
  assert.match(source, /--target-platform "\$TARGETPLATFORM"/);
  assert.match(source, /--target-libc musl/);
  assert.match(source, /--target-node-major 24/);
  assert.equal((source.match(/^RUN node scripts\/lib\/frontend-standalone-artifact-contract\.mjs /gm) ?? []).length, 1);
  assert.ok(source.indexOf('RUN node scripts/lib/frontend-standalone-artifact-contract.mjs ') < source.indexOf('FROM base AS runtime'));
  assert.doesNotMatch(source, /npm (?:ci|install)|pnpm|COPY apps\/web\/|COPY packages\/|--from=build|--from=frontend_artifact|^ARG FRONTEND_ARTIFACT_[^\n]*=/m);
}

test('opt-in Docker consumes only an explicit validated rootfs using the frontend-owned runtime profile', () => {
  validate(DOCKER);
});

test('default Web Docker, release operator, workspace, lock and Onboard default remain unchanged', () => {
  for (const file of ['apps/web/Dockerfile',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/onboard-api/Dockerfile']) {
    const before = execFileSync('git', ['show', `${BASE}:${file}`], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(read(file), before, file);
  }
  // The receiving branch has no active legacy release operator. Do not restore it as a dependency.
  assert.equal(existsSync(path.join(ROOT, 'scripts/build-newsletter-release.sh')), false);
  assert.match(read('apps/web/Dockerfile'), /^EXPOSE 8080$/m);
});

test('missing pins, bypassed byte gate, guessed image stage and changed runtime cannot qualify', () => {
  for (const changed of [
    DOCKER.replace('ARG FRONTEND_ARTIFACT_SOURCE_COMMIT\n', ''),
    DOCKER.replace('ARG FRONTEND_ARTIFACT_SOURCE_COMMIT\n', 'ARG FRONTEND_ARTIFACT_SOURCE_COMMIT=main\n'),
    DOCKER.replace('RUN node scripts/lib/frontend-standalone-artifact-contract.mjs ', 'RUN echo '),
    DOCKER.replace('--from=artifact-check', '--from=frontend_artifact'),
    DOCKER.replace('USER node', 'USER root'),
    DOCKER.replace('PORT=8080', 'PORT=5188'),
    DOCKER.replace('CMD ["node", "apps/web/server.js"]', 'CMD ["node", "server.js"]'),
    DOCKER.replace('zlib=1.3.2-r1', 'zlib'),
    DOCKER.replace('--target-platform "$TARGETPLATFORM"', '--target-platform linux/amd64'),
    DOCKER.replace('--target-libc musl', '--target-libc glibc'),
    DOCKER.replace('FROM base AS runtime', 'COPY apps/web/src apps/web/src\nFROM base AS runtime'),
  ]) assert.throws(() => validate(changed));
});
