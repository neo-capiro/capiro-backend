// Backend-owned qualification identities only. Source is read as data, never imported.
// Current Web conformance remains a separately scoped frontend-parity obligation.
// Engagement retains apps/api/scripts/engagement-phase3-owned-fixture.spec.mjs;
// this guard does not duplicate its 183851-byte input or its four existing cases.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lstatSync, readFileSync, existsSync, mkdtempSync, mkdirSync,
  writeFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const INPUTS = Object.freeze([
  {
    path: 'apps/intel-api/test/qualification/hearing-recording-transport.ts',
    bytes: 4488,
    sha256: '7e7c755fb2ab2894a87509f525a194e88078425603c8d158322768460265fa04',
    blob: 'd1a0a1640572db302a6bbb795392f3857a61216c',
  },
  {
    path: 'apps/intel-api/src/tracker/__fixtures__/email-cta-app-source.txt',
    bytes: 30256,
    sha256: 'a7b1ff2a7cb9945af55ba58c5849cfe18cf5f89a47c195d99e7edac1fcbfe2cc',
    blob: '24d75b1bd4d3e22d4eb0027b9412b33281a84c85',
  },
]);
export const READER_PATHS = Object.freeze([
  'apps/intel-api/test/qualification/hearing-browser-run.ts',
  'apps/intel-api/src/tracker/email-cta-routes.spec.ts',
]);
// Core qualification input provenance. Preserved alternate App variants remain
// Intel0732:25c7507c2d8a49ec70a7916ea40e67b0b6bda6e2 (29830 bytes),
// Memory32a:1a1d2d180788762645df5ad832182c57587b8fe7 (26264 bytes).
// No variant is promoted to shared/public router authority by these identities.
export const DECLARED_CORE_SOURCE = '1e99f0921b207318c6d2abf03927b5c4daa5768b';
const originalCtaReaderSha256 = '72723557f0ba18f258ab3a6fd083ca93d3fd9b963c9689084c640ae3a2e87d6e';
const originalCtaInput = "const APP_TSX = join(REPO_ROOT, 'apps/web/src/App.tsx');";
const ownedCtaInput = "const APP_TSX = join(REPO_ROOT, 'apps/intel-api/src/tracker/__fixtures__/email-cta-app-source.txt');";
const ownedTransportRead = "readFileSync(resolve('test', 'qualification', 'hearing-recording-transport.ts'), 'utf8')";
const ownedTransportFingerprint = "    'test/qualification/hearing-recording-transport.ts',";
const legacyTransportReads = Object.freeze([
  '../web/src/lib/hearing-recording-transport.ts',
  "resolve('..', 'web', 'src', 'lib', 'hearing-recording-transport.ts')",
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const newAudit = () => ({ reads: [], stats: [] });
function readRegular(rootDirectory, path, audit) {
  assert.ok(typeof path === 'string' && path && !path.startsWith('/') && !path.includes('\\')
    && !path.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe qualification path');
  audit.stats.push('.');
  const rootStat = lstatSync(rootDirectory);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'qualification root must be a regular directory');
  const parts = path.split('/');
  for (let count = 1; count <= parts.length; count++) {
    const segment = parts.slice(0, count).join('/');
    audit.stats.push(segment);
    const stat = lstatSync(resolve(rootDirectory, segment));
    assert.ok(!stat.isSymbolicLink(), 'qualification source must not traverse a symlink: ' + segment);
    assert.ok(count === parts.length ? stat.isFile() : stat.isDirectory(),
      'qualification source must remain a regular file with directory ancestors: ' + segment);
  }
  audit.reads.push(path);
  return readFileSync(resolve(rootDirectory, path));
}
export function verifyBackendOwnedQualificationInputs(rootDirectory, audit = newAudit()) {
  for (const input of INPUTS) {
    const bytes = readRegular(rootDirectory, input.path, audit);
    assert.equal(bytes.length, input.bytes, 'owned qualification byte-count drift: ' + input.path);
    assert.equal(sha256(bytes), input.sha256, 'owned qualification identity drift: ' + input.path);
    assert.equal(gitBlob(bytes), input.blob, 'owned qualification Git blob drift: ' + input.path);
  }
  const browser = readRegular(rootDirectory, READER_PATHS[0], audit).toString('utf8');
  assert.equal(browser.split(ownedTransportRead).length - 1, 1, 'owned transport read operand drift');
  assert.equal(browser.split(ownedTransportFingerprint).length - 1, 1, 'owned transport fingerprint operand drift');
  for (const legacy of legacyTransportReads) assert.equal(browser.includes(legacy), false, 'legacy Web transport reader remains');
  const cta = readRegular(rootDirectory, READER_PATHS[1], audit).toString('utf8');
  assert.equal(cta.split(ownedCtaInput).length - 1, 1, 'owned CTA read operand drift');
  assert.equal(sha256(Buffer.from(cta.replace(ownedCtaInput, originalCtaInput))), originalCtaReaderSha256,
    'original CTA case, parser or assertion drift');
  assert.equal(audit.reads.some(path => path.startsWith('apps/web/')), false, 'Web read is outside backend input qualification');
  return audit;
}
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'backend-owned-qualification-'));
  try {
    for (const path of [...INPUTS.map(input => input.path), ...READER_PATHS]) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(resolve(root, path)));
    }
    run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const change = (directory, path, edit) => {
  const file = join(directory, path);
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
};

test('owned Intel transport and CTA data retain immutable byte/blob and reader identities', () => {
  const audit = verifyBackendOwnedQualificationInputs(root);
  assert.deepEqual(audit.reads, [...INPUTS.map(input => input.path), ...READER_PATHS]);
});
test('minimal four-file backend tree qualifies with Web absent and zero Web read/stat attempts', () => fixture(directory => {
  assert.equal(existsSync(join(directory, 'apps/web')), false);
  const audit = verifyBackendOwnedQualificationInputs(directory);
  assert.equal(audit.reads.length, 4);
  assert.equal([...audit.reads, ...audit.stats].some(path => path.startsWith('apps/web')), false);
}));
test('missing either owned input is refused', () => {
  for (const input of INPUTS) fixture(directory => {
    rmSync(join(directory, input.path));
    assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /ENOENT/);
  });
});
test('one-byte same-path drift in either owned input is refused', () => {
  for (const input of INPUTS) fixture(directory => {
    const bytes = readFileSync(join(directory, input.path)); bytes[0] ^= 1;
    writeFileSync(join(directory, input.path), bytes);
    assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /qualification identity drift/);
  });
});
test('symlink substitution of every input or reader is refused before reading it', () => {
  for (const path of [...INPUTS.map(input => input.path), ...READER_PATHS]) fixture(directory => {
    rmSync(join(directory, path)); symlinkSync('missing-owned-source', join(directory, path));
    const audit = newAudit();
    assert.throws(() => verifyBackendOwnedQualificationInputs(directory, audit), /symlink/);
    assert.equal(audit.reads.includes(path), false);
  });
});
test('directory substitution of every input or reader is refused before reading it', () => {
  for (const path of [...INPUTS.map(input => input.path), ...READER_PATHS]) fixture(directory => {
    rmSync(join(directory, path)); mkdirSync(join(directory, path));
    const audit = newAudit();
    assert.throws(() => verifyBackendOwnedQualificationInputs(directory, audit), /regular file/);
    assert.equal(audit.reads.includes(path), false);
  });
});
test('symlink substitution of an ancestor is refused before any data read', () => fixture(directory => {
  rmSync(join(directory, 'apps/intel-api/test/qualification'), { recursive: true });
  symlinkSync('missing-owned-directory', join(directory, 'apps/intel-api/test/qualification'));
  const audit = newAudit();
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory, audit), /symlink/);
  assert.deepEqual(audit.reads, []);
}));
test('transport dynamic source-read operand drift is refused', () => fixture(directory => {
  change(directory, READER_PATHS[0], source => source.replace(ownedTransportRead, ownedTransportRead.replace('hearing-recording-transport.ts', 'missing-transport.ts')));
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /transport read operand drift/);
}));
test('transport fingerprint operand drift is refused', () => fixture(directory => {
  change(directory, READER_PATHS[0], source => source.replace(ownedTransportFingerprint, "    'test/qualification/missing-transport.ts',"));
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /transport fingerprint operand drift/);
}));
test('a restored legacy Web transport source operand is refused', () => fixture(directory => {
  change(directory, READER_PATHS[0], source => source + '\n// ' + legacyTransportReads[1]);
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /legacy Web transport reader remains/);
}));
test('a restored original CTA Web read operand is refused', () => fixture(directory => {
  change(directory, READER_PATHS[1], source => source.replace(ownedCtaInput, originalCtaInput));
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /CTA read operand drift/);
}));
test('removing the original CTA both-rails assertion is refused', () => fixture(directory => {
  change(directory, READER_PATHS[1], source => source.replace("    expect([...files].some((f) => f.includes('apps/api/src/tracker'))).toBe(true);\n", ''));
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /CTA case, parser or assertion drift/);
}));
test('skipping the original dynamic CTA presence case is refused', () => fixture(directory => {
  change(directory, READER_PATHS[1], source => source.replace("  test('the declared dynamic CTAs are actually present in source'", "  test.skip('the declared dynamic CTAs are actually present in source'"));
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /CTA case, parser or assertion drift/);
}));
test('changing the original CTA parser operand is refused', () => fixture(directory => {
  change(directory, READER_PATHS[1], source => source.replace("if (!raw.startsWith('/')) continue;", "if (!raw.startsWith('/ignored')) continue;"));
  assert.throws(() => verifyBackendOwnedQualificationInputs(directory), /CTA case, parser or assertion drift/);
}));
