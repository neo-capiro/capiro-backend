import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { LEGACY_SOURCE_COMMIT } from './inputs.mjs';

/** Explicit historical replay input; never creates or restores a checkout. */
export function requirePinnedLegacySourceRoot() {
  const supplied = process.env.CAPIRO_LEGACY_WEB_SOURCE_ROOT?.trim();
  if (!supplied) {
    throw new Error(`Historical UI qualification requires CAPIRO_LEGACY_WEB_SOURCE_ROOT pointing to a clean read-only checkout of ${LEGACY_SOURCE_COMMIT}. See tests/support/legacy-web/README.md. Backend qualification does not claim this frontend proof.`);
  }
  const root = path.resolve(supplied);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git(['rev-parse', 'HEAD']), LEGACY_SOURCE_COMMIT, 'Historical replay source commit drift');
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', 'apps/web/src', 'apps/api/src/engagement']), '',
    'Historical replay inputs must be clean, including untracked source');
  return root;
}
