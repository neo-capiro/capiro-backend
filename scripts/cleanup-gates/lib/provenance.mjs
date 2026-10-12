/**
 * Source provenance for the coverage baseline.
 *
 * The historical baseline must be anchored to the MEASURED SOURCE and stay
 * immutable across later cleanup phases. It must NOT require the baseline's
 * runSha to equal every future HEAD (that is a self-reference error: the commit
 * that adds the baseline can never equal the commit it is measured from, and
 * every later refactor would invalidate it).
 *
 * Instead we record a fingerprint of the COMPLETE coverage-relevant input set
 * as a sorted list of (path, git-blob-sha) at the measured commit. Independent
 * review round 3 found the previous implementation omitted every production/
 * test source input (it only covered root manifests + per-package
 * `package.json`), so an actual API source change left the fingerprint
 * identical. The input set is now derived from `MEASURED_SOURCE_SPECS`
 * (directory specs recurse via `git ls-tree -r`, so every source file counts)
 * and covers:
 *   - all workspace source roots (apps/, packages/, infra/),
 *   - the root dependency/workspace/turbo/tsconfig contracts,
 *   - the runner/gate implementation itself,
 *   - the CI workflow definitions that decide the acceptance environment.
 *
 * A directory spec contributes every tracked file beneath it, so the
 * fingerprint:
 *   - is verifiable at any later time from git alone (the commit is immutable),
 *   - is stable across evidence-only commits (which touch docs/plans, not the
 *     measured source/config paths),
 *   - changes exactly when measured source/config changes, so a later phase can
 *     tell "same measured source" from "source moved".
 *
 * The verifier re-derives the spec set from `MEASURED_SOURCE_SPECS` (a fixed
 * constant) rather than trusting the manifest's own `paths` list, so a manifest
 * cannot be its own completeness proof.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MEASURED_SOURCE_SPECS } from '../gate-config.mjs';

export const FINGERPRINT_ALGORITHM = 'sha256-ls-tree-v2';

/**
 * The complete measured-source input SPEC set for THIS checkout. Derived from
 * the fixed `MEASURED_SOURCE_SPECS` constant (not a mutable directory walk), so
 * the same list is reproducible from any checkout and any commit. Directory
 * specs are kept as-is and expanded by `git ls-tree -r`.
 */
export function provenancePaths(root = null) {
  return [...MEASURED_SOURCE_SPECS];
}

/**
 * Compute the fingerprint over an explicit path-spec list at a specific commit.
 * Directory specs are expanded recursively by `git ls-tree -r`. Returns
 * { ok, fingerprint, entries, error }.
 */
export function fingerprintAt(root, sha, paths) {
  const list = Array.isArray(paths) && paths.length ? paths : provenancePaths(root);
  const res = spawnSync('git', ['ls-tree', '-r', sha, '--', ...list], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return { ok: false, fingerprint: null, entries: null, error: res.error.message };
  if (res.status !== 0) return { ok: false, fingerprint: null, entries: null, error: (res.stderr || '').trim() || `git ls-tree exited ${res.status}` };
  const entries = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split('\t');
      const blob = String(meta).split(/\s+/)[2];
      return { path: p, blob };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const h = crypto.createHash('sha256');
  for (const e of entries) h.update(`${e.path}\t${e.blob}\n`);
  return { ok: true, fingerprint: h.digest('hex'), entries, error: null };
}

/** True if `sha` is a real commit in this repo. */
export function commitExists(root, sha) {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  return res.status === 0;
}

/** True if `sha` is an ancestor of (or equal to) `headSha`. */
export function isAncestor(root, sha, headSha) {
  const res = spawnSync('git', ['merge-base', '--is-ancestor', sha, headSha], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  return res.status === 0;
}

/** True if the path is tracked and byte-identical to its committed HEAD blob. */
export function trackedAndClean(root, relPath) {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', relPath], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  if (tracked.status !== 0) return { tracked: false, clean: false };
  const diff = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', relPath], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  // exit 0 => no diff, 1 => differs, other => error
  return { tracked: true, clean: diff.status === 0 };
}

export function headSha(root) {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Re-export for callers that only need the constant spec list. */
export { MEASURED_SOURCE_SPECS };
