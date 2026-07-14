import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  validateDirectorySnapshot,
  type DirectoryValidationApproval,
  type DirectorySnapshotValidationReport,
} from './directory-snapshot-validation.js';
import {
  hasRequiredMemberIdentity,
  hasRequiredOfficeIdentity,
  hasRequiredStaffIdentity,
} from './legistorm-types.js';

const DEFAULT_ROOT_PREFIX = 'UPDATED DIRECTORY';
const SNAPSHOT_ID = /^active-current-\d{8}T\d{6}Z$/;

export interface DirectoryLatestPointer {
  schema_version: '2.0.0';
  snapshot_id: string;
  snapshot_prefix: string;
  previous_snapshot_id: string | null;
  previous_snapshot_prefix: string | null;
  published_at: string;
  manifest_key: string;
  validation_key: string;
  counts: { members: number; staff: number; offices: number };
  checksums: {
    member_combined_sha256: string;
    staff_combined_sha256: string;
    office_combined_sha256: string;
  };
  overlays?: {
    memberBios: OverlayFingerprint;
    memberPress: OverlayFingerprint;
  };
}

export interface DirectoryS3Client {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
}

export interface DirectoryRawPage {
  page: number;
  body: unknown[];
}

export interface DirectorySnapshotPublishInput {
  baseline: { snapshotId: string; latestEtag: string };
  approval?: DirectoryValidationApproval;
  snapshotId: string;
  publishedAt: string;
  rawPages: {
    members: DirectoryRawPage[];
    offices: DirectoryRawPage[];
    staff: DirectoryRawPage[];
  };
  active: { members: unknown[]; staff: unknown[]; offices: unknown[] };
  tombstones: { office: number[]; staff: number[] };
  validation: DirectorySnapshotValidationReport;
}

export interface OverlayFingerprint {
  key: string;
  sha256: string;
  versionId: string | null;
}

export interface DirectoryCurrentSnapshot {
  pointer: DirectoryLatestPointer;
  latestEtag: string;
  active: { members: unknown[]; staff: unknown[]; offices: unknown[] };
  sourceObjects: {
    members: OverlayFingerprint;
    staff: OverlayFingerprint;
    offices: OverlayFingerprint;
  };
  overlays: {
    memberBios: OverlayFingerprint;
    memberPress: OverlayFingerprint;
  };
}

export interface DirectorySnapshotPublisherOptions {
  s3: DirectoryS3Client;
  bucket: string;
  rootPrefix?: string;
}

export interface DirectoryPublishResult {
  pointer: DirectoryLatestPointer;
  manifest: Record<string, unknown>;
}

export class DirectorySnapshotPublisher {
  private readonly s3: DirectoryS3Client;
  private readonly bucket: string;
  private readonly root: string;

  constructor(options: DirectorySnapshotPublisherOptions) {
    if (!options.bucket.trim()) throw new Error('directory bucket is required');
    this.s3 = options.s3;
    this.bucket = options.bucket;
    this.root = (options.rootPrefix ?? DEFAULT_ROOT_PREFIX).replace(/\/+$/, '');
  }

  async loadCurrentSnapshot(): Promise<DirectoryCurrentSnapshot> {
    const latest = await this.readObject(`${this.root}/LATEST.json`);
    const pointer = parsePointer(latest.bytes);
    const [memberSource, staffSource, officeSource, overlays] = await Promise.all([
      this.readGzipJsonObject(`${pointer.snapshot_prefix}/combined/member-list-current.json.gz`),
      this.readGzipJsonObject(`${pointer.snapshot_prefix}/combined/staff-list-current.json.gz`),
      this.readGzipJsonObject(`${pointer.snapshot_prefix}/combined/office-list-current.json.gz`),
      this.readOverlayFingerprints(),
    ]);
    assertPriorChecksum(
      'member',
      memberSource.fingerprint.sha256,
      pointer.checksums.member_combined_sha256,
    );
    assertPriorChecksum(
      'staff',
      staffSource.fingerprint.sha256,
      pointer.checksums.staff_combined_sha256,
    );
    assertPriorChecksum(
      'office',
      officeSource.fingerprint.sha256,
      pointer.checksums.office_combined_sha256,
    );
    const members = memberSource.value;
    const staff = staffSource.value;
    const offices = officeSource.value;
    if (!Array.isArray(members) || !Array.isArray(staff) || !Array.isArray(offices)) {
      throw new Error('current directory combined object must contain a JSON array');
    }
    if (!latest.etag) throw new Error('LATEST.json ETag is required for conditional publication');
    // The live list combined files are MIXED arrays (e.g. office rows + a trailing
    // { office_member_addresses } element with no `office`). Filter the baseline to
    // valid records only — the same way the client filters incoming pages — so the
    // merge/validation don't throw-all on a non-record element. Non-degrading: office
    // rows keep their own per-row office_member_addresses; the trailing element is
    // redundant and the reader already ignores it. Checksum verification above is on
    // the raw bytes, so it is unaffected by this parsed-array filtering.
    return {
      pointer,
      latestEtag: latest.etag,
      active: {
        members: members.filter(hasRequiredMemberIdentity),
        staff: staff.filter(hasRequiredStaffIdentity),
        offices: offices.filter(hasRequiredOfficeIdentity),
      },
      sourceObjects: {
        members: memberSource.fingerprint,
        staff: staffSource.fingerprint,
        offices: officeSource.fingerprint,
      },
      overlays,
    };
  }

  async publish(input: DirectorySnapshotPublishInput): Promise<DirectoryPublishResult> {
    if (
      !input.validation.valid ||
      input.validation.errors.length > 0 ||
      input.validation.gates.some((gate) => !gate.passed)
    ) {
      throw new Error('directory snapshot validation failed');
    }
    if (!SNAPSHOT_ID.test(input.snapshotId)) throw new Error('invalid directory snapshot ID');

    const baseline = await this.loadCurrentSnapshot();
    if (
      baseline.pointer.snapshot_id !== input.baseline.snapshotId ||
      baseline.latestEtag !== input.baseline.latestEtag
    ) {
      throw new Error('directory publication baseline changed before publish');
    }
    const validation = validateDirectorySnapshot({
      previous: baseline.active,
      next: input.active,
      retiredIds: { office: input.tombstones.office, staff: input.tombstones.staff },
      approval: input.approval,
    });
    if (!validation.valid) throw new Error('recomputed validation failed for directory snapshot');
    if (JSON.stringify(validation) !== JSON.stringify(input.validation)) {
      throw new Error('directory validation report mismatch');
    }
    const snapshotPrefix = `${this.root}/snapshots/${input.snapshotId}`;
    if (snapshotPrefix === baseline.pointer.snapshot_prefix) {
      throw new Error('new snapshot prefix must differ from current snapshot');
    }

    const rawObjects = [
      ...pageObjects(snapshotPrefix, 'member-list-current', input.rawPages.members),
      ...pageObjects(snapshotPrefix, 'office-list-current', input.rawPages.offices),
      ...pageObjects(snapshotPrefix, 'staff-list-current', input.rawPages.staff),
    ];
    const combinedObjects = [
      gzipObject(`${snapshotPrefix}/combined/member-list-current.json.gz`, input.active.members),
      gzipObject(`${snapshotPrefix}/combined/office-list-current.json.gz`, input.active.offices),
      gzipObject(`${snapshotPrefix}/combined/staff-list-current.json.gz`, input.active.staff),
    ];
    const tombstoneObjects = [
      gzipObject(
        `${snapshotPrefix}/tombstones/office-retired-ids.json.gz`,
        input.tombstones.office,
      ),
      gzipObject(`${snapshotPrefix}/tombstones/staff-retired-ids.json.gz`, input.tombstones.staff),
    ];
    const validationObject = jsonObject(`${snapshotPrefix}/validation.json`, validation);
    const dataObjects = [...rawObjects, ...combinedObjects, ...tombstoneObjects];
    const manifest = {
      schema_version: '2.0.0',
      snapshot_id: input.snapshotId,
      snapshot_prefix: snapshotPrefix,
      previous_snapshot_id: baseline.pointer.snapshot_id,
      previous_snapshot_prefix: baseline.pointer.snapshot_prefix,
      published_at: input.publishedAt,
      counts: {
        members: input.active.members.length,
        staff: input.active.staff.length,
        offices: input.active.offices.length,
      },
      overlays: baseline.overlays,
      objects: [...dataObjects, validationObject].map((object) => ({
        key: object.key,
        sha256: object.sha256,
        bytes: object.body.byteLength,
      })),
    };
    const manifestObject = jsonObject(`${snapshotPrefix}/manifest.json`, manifest);

    for (const object of rawObjects) await this.putImmutable(object);
    for (const object of combinedObjects) await this.putImmutable(object);
    for (const object of tombstoneObjects) await this.putImmutable(object);
    await this.putImmutable(manifestObject);
    await this.putImmutable(validationObject);

    await this.verifyStaged(
      [...dataObjects, manifestObject, validationObject],
      new Map<string, unknown>([
        [combinedObjects[0]!.key, input.active.members],
        [combinedObjects[1]!.key, input.active.offices],
        [combinedObjects[2]!.key, input.active.staff],
      ]),
    );
    const overlaysAfter = await this.readOverlayFingerprints();
    if (!sameOverlayFingerprints(baseline.overlays, overlaysAfter)) {
      throw new Error('directory overlay changed during snapshot publication');
    }

    const pointer: DirectoryLatestPointer = {
      schema_version: '2.0.0',
      snapshot_id: input.snapshotId,
      snapshot_prefix: snapshotPrefix,
      previous_snapshot_id: baseline.pointer.snapshot_id,
      previous_snapshot_prefix: baseline.pointer.snapshot_prefix,
      published_at: input.publishedAt,
      manifest_key: manifestObject.key,
      validation_key: validationObject.key,
      counts: {
        members: input.active.members.length,
        staff: input.active.staff.length,
        offices: input.active.offices.length,
      },
      checksums: {
        member_combined_sha256: combinedObjects[0]!.sha256,
        office_combined_sha256: combinedObjects[1]!.sha256,
        staff_combined_sha256: combinedObjects[2]!.sha256,
      },
      overlays: baseline.overlays,
    };
    const pointerBody = Buffer.from(JSON.stringify(pointer), 'utf8');
    await this.putImmutable({
      key: `${this.root}/pointers/${input.snapshotId}.json`,
      body: pointerBody,
      sha256: sha256(pointerBody),
      contentType: 'application/json; charset=utf-8',
    });
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.root}/LATEST.json`,
        Body: pointerBody,
        ContentType: 'application/json; charset=utf-8',
        ServerSideEncryption: 'AES256',
        IfMatch: input.baseline.latestEtag,
      }),
    );

    return { pointer, manifest };
  }

  private async verifyStaged(
    objects: SnapshotObject[],
    expectedJson: ReadonlyMap<string, unknown>,
  ): Promise<void> {
    for (const object of objects) {
      const staged = await this.readObject(object.key);
      if (sha256(staged.bytes) !== object.sha256) {
        throw new Error(`staged directory object checksum mismatch: ${object.key}`);
      }
      let parsed: unknown;
      try {
        const jsonBytes =
          object.contentEncoding === 'gzip' ? gunzipSync(staged.bytes) : staged.bytes;
        parsed = JSON.parse(Buffer.from(jsonBytes).toString('utf8'));
      } catch {
        throw new Error(`staged directory object failed gzip/JSON verification: ${object.key}`);
      }
      const expected = expectedJson.get(object.key);
      if (expected !== undefined && JSON.stringify(parsed) !== JSON.stringify(expected)) {
        throw new Error(`staged directory object content mismatch: ${object.key}`);
      }
    }
  }

  private async readOverlayFingerprints(): Promise<DirectoryCurrentSnapshot['overlays']> {
    const memberBios = await this.fingerprint(`${this.root}/overlays/member-bios-v1.json`);
    const memberPress = await this.fingerprint(`${this.root}/overlays/member-press-v1.json`);
    return { memberBios, memberPress };
  }

  private async fingerprint(key: string): Promise<OverlayFingerprint> {
    const object = await this.readObject(key);
    if (!object.versionId) throw new Error(`directory object VersionId missing: ${key}`);
    return { key, sha256: sha256(object.bytes), versionId: object.versionId };
  }

  private async readGzipJsonObject(
    key: string,
  ): Promise<{ value: unknown; fingerprint: OverlayFingerprint }> {
    const object = await this.readObject(key);
    if (!object.versionId) throw new Error(`directory object VersionId missing: ${key}`);
    try {
      return {
        value: JSON.parse(gunzipSync(object.bytes).toString('utf8')),
        fingerprint: { key, sha256: sha256(object.bytes), versionId: object.versionId },
      };
    } catch {
      throw new Error(`directory object failed gzip/JSON parsing: ${key}`);
    }
  }

  private async readObject(
    key: string,
  ): Promise<{ bytes: Uint8Array; etag: string | null; versionId: string | null }> {
    const response = (await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as {
      Body?: { transformToByteArray?: () => Promise<Uint8Array> };
      ETag?: string;
      VersionId?: string;
    };
    if (!response.Body?.transformToByteArray)
      throw new Error(`directory object body missing: ${key}`);
    return {
      bytes: await response.Body.transformToByteArray(),
      etag: response.ETag ?? null,
      versionId: response.VersionId ?? null,
    };
  }

  private async putImmutable(object: SnapshotObject): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: object.key,
        Body: object.body,
        ContentType: object.contentType,
        ContentEncoding: object.contentEncoding,
        ServerSideEncryption: 'AES256',
        IfNoneMatch: '*',
      }),
    );
  }
}

interface SnapshotObject {
  key: string;
  body: Uint8Array;
  sha256: string;
  contentType: string;
  contentEncoding?: string;
}

function pageObjects(prefix: string, name: string, pages: DirectoryRawPage[]): SnapshotObject[] {
  return [...pages]
    .sort((left, right) => left.page - right.page)
    .map((page) =>
      gzipObject(
        `${prefix}/raw/${name}/page-${String(page.page).padStart(5, '0')}.json.gz`,
        page.body,
      ),
    );
}

function gzipObject(key: string, value: unknown): SnapshotObject {
  const body = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 9 });
  return {
    key,
    body,
    sha256: sha256(body),
    contentType: 'application/json; charset=utf-8',
    contentEncoding: 'gzip',
  };
}

function jsonObject(key: string, value: unknown): SnapshotObject {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    key,
    body,
    sha256: sha256(body),
    contentType: 'application/json; charset=utf-8',
  };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertPriorChecksum(kind: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`prior combined checksum mismatch for ${kind}`);
  }
}

function parsePointer(bytes: Uint8Array): DirectoryLatestPointer {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('LATEST.json is not valid JSON');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schema_version?: unknown }).schema_version !== '2.0.0' ||
    typeof (value as { snapshot_id?: unknown }).snapshot_id !== 'string' ||
    typeof (value as { snapshot_prefix?: unknown }).snapshot_prefix !== 'string'
  ) {
    throw new Error('LATEST.json does not match directory pointer schema 2.0.0');
  }
  return value as DirectoryLatestPointer;
}

function sameOverlayFingerprints(
  before: DirectoryCurrentSnapshot['overlays'],
  after: DirectoryCurrentSnapshot['overlays'],
): boolean {
  return (
    before.memberBios.sha256 === after.memberBios.sha256 &&
    before.memberBios.versionId === after.memberBios.versionId &&
    before.memberPress.sha256 === after.memberPress.sha256 &&
    before.memberPress.versionId === after.memberPress.versionId
  );
}
