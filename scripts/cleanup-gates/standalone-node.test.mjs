/**
 * Meaningful controls for the standalone Node-suite discovery helper.
 *
 * These exercise the ACTUAL exported `discoverStandaloneNodeSuites` against real
 * temporary filesystem fixtures — including real directory junctions/symlinks
 * for the linked-boundary refusals — and an injected fs boundary only for the
 * file-level provenance refusal that needs no elevated privilege. They do not
 * mirror the implementation or compare source text: each asserts observable
 * discovery behaviour the gate depends on.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverStandaloneNodeSuites } from './lib/standalone-node.mjs';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-node-'));
}

function writeFile(abs, contents = '// fixture\n') {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Remove a directory link/junction itself, never recursing into (or deleting)
 * its target. Tries each portable strategy in turn: a plain rm (unlinks a
 * symlink) and rmdir (removes a Windows junction via RemoveDirectory without
 * following it) cover Windows junctions and POSIX symlinks alike.
 */
function removeLink(linkPath) {
  for (const attempt of [
    () => fs.rmSync(linkPath, { recursive: false, force: false }),
    () => fs.rmdirSync(linkPath),
    () => fs.unlinkSync(linkPath),
  ]) {
    try {
      attempt();
      return;
    } catch {
      /* try the next strategy; the enclosing temp-tree cleanup is the backstop */
    }
  }
}

/**
 * Create a REAL directory link: an NTFS directory junction on Windows (no admin
 * needed) and a plain directory symlink elsewhere. `target` must already exist
 * and be an absolute path.
 */
function makeDirectoryLink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');
}

function suiteFor(result, rel) {
  return result.suites.find((s) => s.packageDir === rel) ?? null;
}

test('discovers a manifest-less app test/*.test.mjs suite and builds a node --test argv', () => {
  const root = makeRoot();
  try {
    writeFile(path.join(root, 'apps', 'app-a', 'test', 'one.test.mjs'));
    writeFile(path.join(root, 'apps', 'app-a', 'test', 'two.test.mjs'));
    writeFile(path.join(root, 'apps', 'app-a', 'test', 'helpers.mjs'));

    const result = discoverStandaloneNodeSuites(root);

    const suite = suiteFor(result, 'apps/app-a');
    assert.ok(suite, 'expected the manifest-less app suite to be discovered');
    assert.equal(suite.files.length, 2);
    assert.deepEqual(
      suite.files.map((f) => path.basename(f)).sort(),
      ['one.test.mjs', 'two.test.mjs'],
    );
    assert.equal(suite.argv[0], '--test');
    assert.equal(suite.argv.length, 1 + suite.files.length);
    assert.deepEqual(result.problems, []);
  } finally {
    cleanup(root);
  }
});

test('a second standalone app added later is noticed by a fresh discovery run', () => {
  const root = makeRoot();
  try {
    writeFile(path.join(root, 'apps', 'app-a', 'test', 'one.test.mjs'));
    const first = discoverStandaloneNodeSuites(root);
    assert.deepEqual(first.suites.map((s) => s.packageDir), ['apps/app-a']);

    writeFile(path.join(root, 'apps', 'app-b', 'test', 'extra.test.mjs'));
    const second = discoverStandaloneNodeSuites(root);
    assert.deepEqual(second.suites.map((s) => s.packageDir), ['apps/app-a', 'apps/app-b']);
    assert.deepEqual(second.problems, []);
  } finally {
    cleanup(root);
  }
});

test('a manifest-bearing app is left to the existing Turbo owner (not discovered, not a problem)', () => {
  const root = makeRoot();
  try {
    writeFile(path.join(root, 'apps', 'manifest-app', 'package.json'), '{"name":"manifest-app"}\n');
    writeFile(path.join(root, 'apps', 'manifest-app', 'test', 'owned.test.mjs'));

    const result = discoverStandaloneNodeSuites(root);
    assert.equal(suiteFor(result, 'apps/manifest-app'), null);
    assert.deepEqual(result.suites, []);
    assert.deepEqual(result.problems, []);
  } finally {
    cleanup(root);
  }
});

test('a test directory with no supported *.test.mjs yields no suite and an explicit problem, never zero-test success', () => {
  const root = makeRoot();
  try {
    writeFile(path.join(root, 'apps', 'nosuite', 'test', 'helper.mjs'));
    writeFile(path.join(root, 'apps', 'nosuite', 'test', 'legacy.spec.ts'));

    const result = discoverStandaloneNodeSuites(root);

    assert.deepEqual(result.suites, []);
    assert.ok(
      result.problems.some((p) => p.app === 'apps/nosuite' && /declares no supported \*\.test\.mjs suite/.test(p.message)),
      `expected an unsupported-scope problem, got ${JSON.stringify(result.problems)}`,
    );
    // No suite is ever surfaced with zero discovered tests.
    for (const suite of result.suites) assert.ok(suite.files.length >= 1);
  } finally {
    cleanup(root);
  }
});

test('a symlinked standalone test file is refused (must be a real regular file)', () => {
  const root = makeRoot();
  try {
    writeFile(path.join(root, 'apps', 'linked', 'test', 'linked.test.mjs'));
    const lstat = (p) =>
      path.basename(p) === 'linked.test.mjs'
        ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
        : fs.lstatSync(p);

    const result = discoverStandaloneNodeSuites(root, { lstat });

    assert.deepEqual(result.suites, []);
    assert.ok(
      result.problems.some((p) => /is a symlink — refused/.test(p.message)),
      `expected a symlink-refusal problem, got ${JSON.stringify(result.problems)}`,
    );
  } finally {
    cleanup(root);
  }
});

test('a standalone test whose real path escapes the owned root is refused', () => {
  const root = makeRoot();
  try {
    writeFile(path.join(root, 'apps', 'escape', 'test', 'escape.test.mjs'));
    const outside = path.join(os.tmpdir(), 'standalone-node-outside', 'escape.test.mjs');
    const realpath = (p) =>
      path.basename(p) === 'escape.test.mjs' ? outside : fs.realpathSync(p);

    const result = discoverStandaloneNodeSuites(root, { realpath });

    assert.deepEqual(result.suites, []);
    assert.ok(
      result.problems.some((p) => /resolves outside the owned root/.test(p.message)),
      `expected a containment-refusal problem, got ${JSON.stringify(result.problems)}`,
    );
  } finally {
    cleanup(root);
  }
});

test('a missing apps root is reported as a problem, never an empty success', () => {
  const root = makeRoot();
  try {
    const result = discoverStandaloneNodeSuites(root);

    assert.deepEqual(result.suites, []);
    assert.ok(
      result.problems.some((p) => p.app === 'apps' && /cannot stat standalone apps root/.test(p.message)),
      `expected an apps-root problem, got ${JSON.stringify(result.problems)}`,
    );
  } finally {
    cleanup(root);
  }
});

test('an apps root that is not a directory is refused as a problem', () => {
  const root = makeRoot();
  try {
    writeFile(path.join(root, 'apps'), 'not a directory\n');

    const result = discoverStandaloneNodeSuites(root);

    assert.deepEqual(result.suites, []);
    assert.ok(
      result.problems.some((p) => p.app === 'apps' && /is not a directory — refused/.test(p.message)),
      `expected a non-directory apps-root problem, got ${JSON.stringify(result.problems)}`,
    );
  } finally {
    cleanup(root);
  }
});

test('a linked (junction) standalone app directory is refused, not silently skipped', () => {
  const root = makeRoot();
  const target = makeRoot();
  const link = path.join(root, 'apps', 'linked-app');
  try {
    // A real, complete standalone app OUTSIDE the owned tree; the link would
    // otherwise let discovery follow it (bypass) or now escape ownership.
    writeFile(path.join(target, 'test', 'real.test.mjs'));
    makeDirectoryLink(target, link);

    const result = discoverStandaloneNodeSuites(root);

    assert.deepEqual(result.suites, []);
    assert.ok(
      result.problems.some(
        (p) => p.app === 'apps/linked-app' && /symlink\/junction — refused|resolves outside the owned root/.test(p.message),
      ),
      `expected a linked-app refusal, got ${JSON.stringify(result.problems)}`,
    );
  } finally {
    removeLink(link);
    cleanup(root);
    cleanup(target);
  }
});

test('a linked (junction) test directory is refused, not silently followed', () => {
  const root = makeRoot();
  const link = path.join(root, 'apps', 'app-b', 'test');
  try {
    // A real sibling app whose suite the link would otherwise alias.
    writeFile(path.join(root, 'apps', 'app-a', 'test', 'one.test.mjs'));
    makeDirectoryLink(path.join(root, 'apps', 'app-a', 'test'), link);

    const result = discoverStandaloneNodeSuites(root);

    // The ordinary real app is still discovered with no problem; only the
    // linked boundary is refused.
    assert.deepEqual(result.suites.map((s) => s.packageDir), ['apps/app-a']);
    assert.ok(
      result.problems.some(
        (p) => p.app === 'apps/app-b' && /test directory .* is a symlink\/junction — refused/.test(p.message),
      ),
      `expected a linked test-directory refusal, got ${JSON.stringify(result.problems)}`,
    );
  } finally {
    removeLink(link);
    cleanup(root);
  }
});