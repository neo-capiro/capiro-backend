import { describe, expect, test } from '@jest/globals';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import memberPage from './__fixtures__/member-page.json';
import officePage from './__fixtures__/office-page.json';
import staffPage from './__fixtures__/staff-page.json';
import {
  DirectorySnapshotPublisher,
  type DirectoryLatestPointer,
} from './directory-snapshot-publisher.js';
import { validateDirectorySnapshot } from './directory-snapshot-validation.js';

const BUCKET = 'fixture-directory-bucket';
const ROOT = 'UPDATED DIRECTORY';
const LATEST_KEY = `${ROOT}/LATEST.json`;
const BIO_KEY = `${ROOT}/overlays/member-bios-v1.json`;
const PRESS_KEY = `${ROOT}/overlays/member-press-v1.json`;
const PRIOR_PREFIX = `${ROOT}/snapshots/active-current-20260712T040000Z`;
const SNAPSHOT_ID = 'active-current-20260713T040000Z';
const SNAPSHOT_PREFIX = `${ROOT}/snapshots/${SNAPSHOT_ID}`;
const PRIOR_MEMBER_GZIP = gzipSync(JSON.stringify(memberPage));
const PRIOR_STAFF_GZIP = gzipSync(JSON.stringify(staffPage));
const PRIOR_OFFICE_GZIP = gzipSync(JSON.stringify(officePage));

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

interface StoredObject {
  body: Uint8Array;
  etag: string;
  versionId: string;
}

class FakeS3 {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  readonly objects = new Map<string, StoredObject>();
  corruptReadKey: string | null = null;
  mutateOverlayBeforeVerification = false;
  private version = 1;
  private stagedReadSeen = false;

  seed(key: string, body: Uint8Array | string, etag = `"etag-${key}"`, versionId = `v-${key}`) {
    this.objects.set(key, { body: bytes(body), etag, versionId });
  }

  async send(command: unknown): Promise<Record<string, unknown>> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.calls.push({ name, input });
    const key = String(input.Key);

    if (command instanceof GetObjectCommand) {
      if (key.startsWith(`${SNAPSHOT_PREFIX}/combined/`) && !this.stagedReadSeen) {
        this.stagedReadSeen = true;
        if (this.mutateOverlayBeforeVerification) {
          this.seed(PRESS_KEY, '{"changed":true}', '"etag-changed"', 'v-changed');
        }
      }
      const stored = this.objects.get(key);
      if (!stored) throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' });
      const body = key === this.corruptReadKey ? bytes('not gzip') : stored.body;
      return {
        Body: {
          transformToByteArray: async () => body,
          transformToString: async () => Buffer.from(body).toString('utf8'),
        },
        ETag: stored.etag,
        VersionId: stored.versionId,
      };
    }

    if (command instanceof PutObjectCommand) {
      const existing = this.objects.get(key);
      if (input.IfNoneMatch === '*' && existing) throw new Error(`precondition failed for ${key}`);
      if (input.IfMatch !== undefined && input.IfMatch !== existing?.etag) {
        throw new Error(`etag precondition failed for ${key}`);
      }
      const stored: StoredObject = {
        body: bytes(input.Body as Uint8Array | string),
        etag: `"put-${this.version}"`,
        versionId: `put-v${this.version}`,
      };
      this.version += 1;
      this.objects.set(key, stored);
      return { ETag: stored.etag, VersionId: stored.versionId };
    }

    throw new Error(`unexpected command ${name}`);
  }
}

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

function priorPointer(): DirectoryLatestPointer {
  return {
    schema_version: '2.0.0',
    snapshot_id: 'active-current-20260712T040000Z',
    snapshot_prefix: PRIOR_PREFIX,
    previous_snapshot_id: null,
    previous_snapshot_prefix: null,
    published_at: '2026-07-12T04:00:00.000Z',
    manifest_key: `${PRIOR_PREFIX}/manifest.json`,
    validation_key: `${PRIOR_PREFIX}/validation.json`,
    counts: { members: 1, staff: 1, offices: 1 },
    checksums: {
      member_combined_sha256: sha256(PRIOR_MEMBER_GZIP),
      staff_combined_sha256: sha256(PRIOR_STAFF_GZIP),
      office_combined_sha256: sha256(PRIOR_OFFICE_GZIP),
    },
  };
}

function seedBaseline(s3: FakeS3): void {
  s3.seed(LATEST_KEY, JSON.stringify(priorPointer()), '"latest-etag"', 'latest-v1');
  s3.seed(`${PRIOR_PREFIX}/combined/member-list-current.json.gz`, PRIOR_MEMBER_GZIP);
  s3.seed(`${PRIOR_PREFIX}/combined/staff-list-current.json.gz`, PRIOR_STAFF_GZIP);
  s3.seed(`${PRIOR_PREFIX}/combined/office-list-current.json.gz`, PRIOR_OFFICE_GZIP);
  s3.seed(BIO_KEY, '{"members":{}}', '"bio-etag"', 'bio-v1');
  s3.seed(PRESS_KEY, '{"members":{}}', '"press-etag"', 'press-v1');
}

function publishInput(valid = true) {
  const validation = validateDirectorySnapshot({
    previous: { members: memberPage, staff: staffPage, offices: officePage },
    next: { members: memberPage, staff: staffPage, offices: officePage },
    retiredIds: { office: [700001], staff: [700002] },
  });
  return {
    baseline: { snapshotId: priorPointer().snapshot_id, latestEtag: '"latest-etag"' },
    snapshotId: SNAPSHOT_ID,
    publishedAt: '2026-07-13T04:00:00.000Z',
    rawPages: {
      members: [{ page: 1, body: memberPage }],
      offices: [{ page: 1, body: officePage }],
      staff: [{ page: 1, body: staffPage }],
    },
    active: { members: memberPage, staff: staffPage, offices: officePage },
    tombstones: { office: [700001], staff: [700002] },
    validation: valid
      ? validation
      : { ...validation, valid: false, errors: ['fixture validation failure'] },
  };
}

function publisher(s3: FakeS3) {
  return new DirectorySnapshotPublisher({ s3, bucket: BUCKET, rootPrefix: ROOT });
}

describe('DirectorySnapshotPublisher', () => {
  test('loads the current pointer, prior combined snapshot, and overlay fingerprints', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);

    const current = await publisher(s3).loadCurrentSnapshot();

    expect(current.pointer).toEqual(priorPointer());
    expect(current.latestEtag).toBe('"latest-etag"');
    expect(current.active).toEqual({ members: memberPage, staff: staffPage, offices: officePage });
    expect(current.overlays).toMatchObject({
      memberBios: { key: BIO_KEY, versionId: 'bio-v1' },
      memberPress: { key: PRESS_KEY, versionId: 'press-v1' },
    });
    expect(current.overlays.memberBios.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(current.sourceObjects).toMatchObject({
      members: { sha256: priorPointer().checksums.member_combined_sha256 },
      staff: { sha256: priorPointer().checksums.staff_combined_sha256 },
      offices: { sha256: priorPointer().checksums.office_combined_sha256 },
    });
    expect(current.sourceObjects.members.versionId).toBeTruthy();
  });

  test('publishes immutable objects in strict order and writes LATEST last', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);

    const result = await publisher(s3).publish(publishInput());

    const puts = s3.calls.filter((call) => call.name === 'PutObjectCommand');
    const putKeys = puts.map((call) => String(call.input.Key));
    expect(putKeys).toEqual([
      `${SNAPSHOT_PREFIX}/raw/member-list-current/page-00001.json.gz`,
      `${SNAPSHOT_PREFIX}/raw/office-list-current/page-00001.json.gz`,
      `${SNAPSHOT_PREFIX}/raw/staff-list-current/page-00001.json.gz`,
      `${SNAPSHOT_PREFIX}/combined/member-list-current.json.gz`,
      `${SNAPSHOT_PREFIX}/combined/office-list-current.json.gz`,
      `${SNAPSHOT_PREFIX}/combined/staff-list-current.json.gz`,
      `${SNAPSHOT_PREFIX}/tombstones/office-retired-ids.json.gz`,
      `${SNAPSHOT_PREFIX}/tombstones/staff-retired-ids.json.gz`,
      `${SNAPSHOT_PREFIX}/manifest.json`,
      `${SNAPSHOT_PREFIX}/validation.json`,
      `${ROOT}/pointers/${SNAPSHOT_ID}.json`,
      LATEST_KEY,
    ]);
    expect(puts.slice(0, -1).every((call) => call.input.IfNoneMatch === '*')).toBe(true);
    expect(puts.at(-1)!.input.IfMatch).toBe('"latest-etag"');
    expect(putKeys.some((key) => key.includes('/overlays/'))).toBe(false);

    const firstStagedGet = s3.calls.findIndex(
      (call) =>
        call.name === 'GetObjectCommand' &&
        String(call.input.Key).startsWith(`${SNAPSHOT_PREFIX}/combined/`),
    );
    const pointerPut = s3.calls.findIndex(
      (call) =>
        call.name === 'PutObjectCommand' &&
        call.input.Key === `${ROOT}/pointers/${SNAPSHOT_ID}.json`,
    );
    expect(firstStagedGet).toBeGreaterThan(-1);
    expect(pointerPut).toBeGreaterThan(firstStagedGet);
    expect(result.pointer.previous_snapshot_prefix).toBe(PRIOR_PREFIX);
    expect(result.pointer.counts).toEqual({ members: 1, staff: 1, offices: 1 });
    expect(result.pointer.checksums.member_combined_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((result.pointer as DirectoryLatestPointer & { overlays: unknown }).overlays).toEqual(
      result.manifest.overlays,
    );

    const stagedArtifactKeys = putKeys.slice(0, 10);
    for (const key of stagedArtifactKeys) {
      const putIndex = s3.calls.findIndex(
        (call) => call.name === 'PutObjectCommand' && call.input.Key === key,
      );
      const verifyIndex = s3.calls.findIndex(
        (call, index) =>
          index > putIndex && call.name === 'GetObjectCommand' && call.input.Key === key,
      );
      expect(verifyIndex).toBeGreaterThan(putIndex);
      expect(pointerPut).toBeGreaterThan(verifyIndex);
    }
    expect(JSON.parse(Buffer.from(s3.objects.get(LATEST_KEY)!.body).toString('utf8'))).toEqual(
      result.pointer,
    );
  });

  test('rejects a prior combined object whose checksum does not match LATEST', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    const corruptedPointer = priorPointer();
    corruptedPointer.checksums.member_combined_sha256 = '0'.repeat(64);
    s3.seed(LATEST_KEY, JSON.stringify(corruptedPointer), '"latest-etag"', 'latest-v1');

    await expect(publisher(s3).loadCurrentSnapshot()).rejects.toThrow('prior combined checksum');
  });

  test('rejects publication when LATEST no longer matches the merge baseline', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    const newer = {
      ...priorPointer(),
      snapshot_id: 'active-current-20260712T120000Z',
      snapshot_prefix: `${ROOT}/snapshots/active-current-20260712T120000Z`,
    };
    s3.seed(LATEST_KEY, JSON.stringify(newer), '"newer-etag"', 'latest-v2');
    s3.seed(`${newer.snapshot_prefix}/combined/member-list-current.json.gz`, PRIOR_MEMBER_GZIP);
    s3.seed(`${newer.snapshot_prefix}/combined/staff-list-current.json.gz`, PRIOR_STAFF_GZIP);
    s3.seed(`${newer.snapshot_prefix}/combined/office-list-current.json.gz`, PRIOR_OFFICE_GZIP);

    await expect(publisher(s3).publish(publishInput())).rejects.toThrow('baseline changed');
    expect(s3.calls.filter((call) => call.name === 'PutObjectCommand')).toHaveLength(0);
  });

  test('publishes an approved threshold exception with its provenance persisted', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    const input = publishInput();
    input.active.staff = [];
    input.tombstones.staff = [800001];
    const approval = {
      approvedBy: 'fixture-operator',
      approvedAt: '2026-07-13T03:30:00.000Z',
      reason: 'Reviewed complete staff retirement evidence',
      gates: ['staffCountDrop'] as const,
    };
    Object.assign(input, { approval: { ...approval, gates: [...approval.gates] } });
    input.validation = validateDirectorySnapshot({
      previous: { members: memberPage, staff: staffPage, offices: officePage },
      next: input.active,
      retiredIds: input.tombstones,
      approval: { ...approval, gates: [...approval.gates] },
    });

    await expect(publisher(s3).publish(input)).resolves.toBeDefined();
    const persisted = JSON.parse(
      Buffer.from(s3.objects.get(`${SNAPSHOT_PREFIX}/validation.json`)!.body).toString('utf8'),
    );
    expect(persisted.approval).toEqual({ ...approval, gates: [...approval.gates] });
  });

  test('rejects a fabricated valid report for malformed active rows', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    const input = publishInput();
    input.active.staff = [{ staff: { id: 800001 } }] as unknown as typeof input.active.staff;

    await expect(publisher(s3).publish(input)).rejects.toThrow('recomputed validation failed');
    expect(s3.calls.filter((call) => call.name === 'PutObjectCommand')).toHaveLength(0);
  });

  test('rejects a stale validation report whose metrics do not match active rows', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    const input = publishInput();
    input.validation.metrics.next.staff = 999;

    await expect(publisher(s3).publish(input)).rejects.toThrow('validation report mismatch');
    expect(s3.calls.filter((call) => call.name === 'PutObjectCommand')).toHaveLength(0);
  });

  test('makes zero writes when validation has failed', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);

    await expect(publisher(s3).publish(publishInput(false))).rejects.toThrow('validation failed');

    expect(s3.calls.filter((call) => call.name === 'PutObjectCommand')).toHaveLength(0);
    expect(JSON.parse(Buffer.from(s3.objects.get(LATEST_KEY)!.body).toString('utf8'))).toEqual(
      priorPointer(),
    );
  });

  test('does not publish either pointer when staged gzip verification fails', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    s3.corruptReadKey = `${SNAPSHOT_PREFIX}/combined/member-list-current.json.gz`;

    await expect(publisher(s3).publish(publishInput())).rejects.toThrow();

    const putKeys = s3.calls
      .filter((call) => call.name === 'PutObjectCommand')
      .map((call) => String(call.input.Key));
    expect(putKeys).not.toContain(`${ROOT}/pointers/${SNAPSHOT_ID}.json`);
    expect(putKeys).not.toContain(LATEST_KEY);
  });

  test('does not publish pointers when any raw, tombstone, manifest, or validation artifact is corrupt', async () => {
    for (const key of [
      `${SNAPSHOT_PREFIX}/raw/member-list-current/page-00001.json.gz`,
      `${SNAPSHOT_PREFIX}/tombstones/staff-retired-ids.json.gz`,
      `${SNAPSHOT_PREFIX}/manifest.json`,
      `${SNAPSHOT_PREFIX}/validation.json`,
    ]) {
      const s3 = new FakeS3();
      seedBaseline(s3);
      s3.corruptReadKey = key;

      await expect(publisher(s3).publish(publishInput())).rejects.toThrow();
      const putKeys = s3.calls
        .filter((call) => call.name === 'PutObjectCommand')
        .map((call) => String(call.input.Key));
      expect(putKeys).not.toContain(`${ROOT}/pointers/${SNAPSHOT_ID}.json`);
      expect(putKeys).not.toContain(LATEST_KEY);
    }
  });

  test('does not publish pointers if an overlay checksum or VersionId changes', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    s3.mutateOverlayBeforeVerification = true;

    await expect(publisher(s3).publish(publishInput())).rejects.toThrow('overlay changed');

    const putKeys = s3.calls
      .filter((call) => call.name === 'PutObjectCommand')
      .map((call) => String(call.input.Key));
    expect(putKeys).not.toContain(`${ROOT}/pointers/${SNAPSHOT_ID}.json`);
    expect(putKeys).not.toContain(LATEST_KEY);
  });

  test('leaves LATEST unchanged when immutable snapshot keys already exist', async () => {
    const s3 = new FakeS3();
    seedBaseline(s3);
    s3.seed(`${SNAPSHOT_PREFIX}/manifest.json`, '{}');

    await expect(publisher(s3).publish(publishInput())).rejects.toThrow('precondition failed');

    expect(JSON.parse(Buffer.from(s3.objects.get(LATEST_KEY)!.body).toString('utf8'))).toEqual(
      priorPointer(),
    );
  });
});
