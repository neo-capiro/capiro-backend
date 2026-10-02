import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, symlink, link, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactCollector, verifyCollectedArtifacts } from '../artifact-collector.mjs';
import { OwnedArtifactReader } from '../artifact-reader.mjs';
import { createWindowsArtifactStorage } from '../windows-artifact-storage.mjs';
import { verifyCaptureBundle } from '../verify-capture.mjs';
import { materializeUnitBundle } from './helpers.mjs';

// Explicit operator-selected local scratch parent and installed interpreter only.
// No default to shared/cloud/environment artifact destinations.
const scratch = process.env.MERI_WINDOWS_ARTIFACT_TEST_ROOT;
const pythonExecutable = process.env.MERI_WINDOWS_ARTIFACT_PYTHON;
const enabled = process.platform === 'win32' && Boolean(scratch && pythonExecutable);
const owner = {
  schemaVersion: 1,
  kind: 'meri-live-v1-artifact-bundle',
  provenance: 'LIVE_CAPTURE',
  captureRunId: 'native-owned-storage-test',
  fixtureVersion: 'test',
  fixtureSha256: 'a'.repeat(64),
  contractSourceSha256: 'b'.repeat(64),
};

async function setup() {
  const root = join(scratch, `native-${randomUUID()}`);
  const storage = createWindowsArtifactStorage(root, { pythonExecutable });
  const collector = new ArtifactCollector(root, owner, ['known-secret-value'], { storage });
  const descriptor = await collector.init();
  return { root, storage, collector, descriptor };
}

test('Windows native collector/reader integration', { skip: !enabled }, async (t) => {
  await mkdir(scratch, { recursive: true });
  await t.test('actual create, redaction, hash, manifest and synchronous reader', async () => {
    const { root, storage, collector, descriptor } = await setup();
    const artifact = await collector.writeText('case/answer.txt', 'hello known-secret-value');
    await collector.finalize({ acceptanceStatus: 'NOT_RUN' });
    assert.equal((await verifyCollectedArtifacts(root, { storage })).valid, true);
    const reader = new OwnedArtifactReader(
      root,
      { ...owner, ownerSha256: descriptor.sha256 },
      { storage },
    );
    assert.equal(reader.readText(artifact).text, 'hello [REDACTED]');
    assert.throws(() => reader.resolveRef(artifact.ref), /does not expose path/);
    assert.throws(() => reader.readBytes(descriptor), /owner marker/);
  });
  await t.test('native storage cannot turn static unit bytes into live acceptance', async () => {
    const oldScratch = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    let unit;
    try {
      unit = materializeUnitBundle([{ id: '03' }]);
    } finally {
      if (oldScratch === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = oldScratch;
    }
    const root = join(scratch, `native-${randomUUID()}`);
    const storage = createWindowsArtifactStorage(root, { pythonExecutable });
    const nativeOwner = JSON.parse(await readFile(join(unit.root, 'bundle-owner.json'), 'utf8'));
    nativeOwner.provenance = 'LIVE_CAPTURE';
    const collector = new ArtifactCollector(root, nativeOwner, [], { storage });
    const descriptor = await collector.init();
    async function copy(prefix = '') {
      for (const entry of await readdir(join(unit.root, prefix), { withFileTypes: true })) {
        const ref = prefix + entry.name;
        if (entry.isDirectory()) await copy(`${ref}/`);
        else if (ref !== 'bundle-owner.json')
          await collector.writeBytes(ref, await readFile(join(unit.root, ref)));
      }
    }
    await copy();
    const report = verifyCaptureBundle(
      { ...unit.bundle, artifactRoot: root, ownerSha256: descriptor.sha256 },
      { artifactStorage: storage },
    );
    assert.equal(report.valid, true, report.errors.join('; '));
    assert.equal(report.counts.PASS, 0);
    const result = report.results.find((row) => row.caseId === '03');
    assert.equal(result.status, 'BLOCKED');
    assert.match(result.reason, /capture\/auth\/source authority/);
  });
  await t.test('duplicate write refuses overwrite and poisons the failed run', async () => {
    const { root, collector } = await setup();
    await collector.writeText('answer.txt', 'original');
    await assert.rejects(collector.writeText('answer.txt', 'overwrite'), /failed closed/);
    assert.equal(await readFile(join(root, 'answer.txt'), 'utf8'), 'original');
    await assert.rejects(collector.finalize({}), /poisoned/);
  });
  await t.test('same-byte file replacement is refused', async () => {
    const { root, collector } = await setup();
    await collector.writeText('answer.txt', 'same bytes');
    await rename(join(root, 'answer.txt'), join(root, 'old.txt'));
    await writeFile(join(root, 'answer.txt'), 'same bytes');
    assert.throws(() => collector.readBytes('answer.txt'), /failed closed/);
  });
  await t.test('same-byte root replacement is refused', async () => {
    const { root, collector } = await setup();
    await rename(root, `${root}-old`);
    await mkdir(root);
    assert.throws(() => collector.readBytes('bundle-owner.json'), /failed closed/);
  });
  await t.test('ordinary parent replacement between operations is refused', async () => {
    const { root, collector } = await setup();
    await collector.writeText('case/a.txt', 'a');
    await rename(join(root, 'case'), join(root, 'prior-case'));
    await mkdir(join(root, 'case'));
    await assert.rejects(collector.writeText('case/b.txt', 'b'), /failed closed/);
  });
  await t.test('current owner bytes must still match on every reader call', async () => {
    const { root, storage, collector, descriptor } = await setup();
    const artifact = await collector.writeText('answer.txt', 'answer');
    const reader = new OwnedArtifactReader(
      root,
      { ...owner, ownerSha256: descriptor.sha256 },
      { storage },
    );
    await writeFile(join(root, 'bundle-owner.json'), '{}');
    assert.throws(() => reader.readBytes(artifact), /failed closed/);
  });
  await t.test('file hardlink alias refuses read even if bytes are unchanged', async () => {
    const { root, collector } = await setup();
    await collector.writeText('answer.txt', 'answer');
    await link(join(root, 'answer.txt'), join(scratch, `${randomUUID()}-alias.txt`));
    assert.throws(() => collector.readBytes('answer.txt'), /failed closed/);
  });
  await t.test('junction parent cannot redirect a new write outside the root', async () => {
    const { root, collector } = await setup();
    const outside = join(scratch, `${randomUUID()}-outside`);
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel.txt'), 'untouched');
    await symlink(outside, join(root, 'case'), 'junction');
    await assert.rejects(collector.writeText('case/sentinel.txt', 'bad'), /failed closed/);
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
  });
  await t.test('junction artifact root ancestor fails before creating run', async () => {
    const outside = join(scratch, `${randomUUID()}-outside`);
    const alias = join(scratch, `${randomUUID()}-junction`);
    await mkdir(outside);
    await symlink(outside, alias, 'junction');
    const root = join(alias, 'new-run');
    const storage = createWindowsArtifactStorage(root, { pythonExecutable });
    await assert.rejects(
      new ArtifactCollector(root, owner, [], { storage }).init(),
      /failed closed/,
    );
  });
  await t.test('external same-byte leaf symlink is refused', async () => {
    const { root, collector } = await setup();
    await collector.writeText('answer.txt', 'answer');
    const outside = join(scratch, `${randomUUID()}-outside.txt`);
    await writeFile(outside, 'answer');
    await rename(join(root, 'answer.txt'), join(root, 'old.txt'));
    await symlink(outside, join(root, 'answer.txt'), 'file');
    assert.throws(() => collector.readBytes('answer.txt'), /failed closed/);
  });
  for (const ref of [
    'x:stream',
    'CON.txt',
    'LPT1',
    '../escape',
    'a\\b',
    'a.',
    'a ',
    'a//b',
    'C:relative',
    'a/\0bad',
  ]) {
    await t.test(`unsafe Windows ref refused: ${JSON.stringify(ref)}`, async () => {
      const { collector } = await setup();
      await assert.rejects(collector.writeText(ref, 'bad'), /failed closed/);
    });
  }
  await t.test('case aliases cannot be read as a second ref', async () => {
    const { collector } = await setup();
    await collector.writeText('answer.txt', 'answer');
    assert.throws(() => collector.readBytes('ANSWER.txt'), /failed closed/);
  });
  await t.test('oversize artifact is rejected before native create', async () => {
    const { collector } = await setup();
    await assert.rejects(
      collector.writeBytes('large.bin', Buffer.alloc(32 * 1024 * 1024 + 1)),
      /byte limit/,
    );
  });
  await t.test('unexpected tree entry blocks completed bundle verification', async () => {
    const { root, storage, collector } = await setup();
    await collector.writeText('answer.txt', 'answer');
    await collector.finalize({});
    await writeFile(join(root, 'unowned.txt'), 'extra');
    assert.equal((await verifyCollectedArtifacts(root, { storage })).valid, false);
  });
  await t.test('missing or non-Python executable fails closed before owner init', async () => {
    const root = join(scratch, `native-${randomUUID()}`);
    const storage = createWindowsArtifactStorage(root, { pythonExecutable: process.execPath });
    await assert.rejects(
      new ArtifactCollector(root, owner, [], { storage }).init(),
      /failed closed/,
    );
  });
});

test('portable LIVE guard and capability branding remain fail closed', () => {
  const root = process.cwd();
  assert.throws(() => new ArtifactCollector(root, owner), { code: 'LIVE_ARTIFACT_PATH_UNSAFE' });
  assert.throws(
    () => new ArtifactCollector(root, owner, [], { storage: { root, safe: true } }),
    /unverified/,
  );
});
