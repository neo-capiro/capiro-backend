import { describe, expect, test } from '@jest/globals';
import memberPage from '../src/directory/legistorm/__fixtures__/member-page.json';
import officePage from '../src/directory/legistorm/__fixtures__/office-page.json';
import staffPage from '../src/directory/legistorm/__fixtures__/staff-page.json';
import {
  DEFAULT_FULL_FLOOR_DATE,
  parseArgs,
  runSyncLegistormDirectory,
  type DirectorySnapshotStore,
  type LegiStormSource,
} from './sync-legistorm-directory.js';
import type {
  DirectoryCurrentSnapshot,
  DirectorySnapshotPublishInput,
} from '../src/directory/legistorm/directory-snapshot-publisher.js';
import type { SyncRunCapablePrisma } from '../src/ingestion/sync-run.helper.js';

const NOW = (): Date => new Date('2026-07-13T18:30:45.123Z');
const WATERMARK = new Date('2026-07-10T00:00:00.000Z');

function members(count: number, options: { photos?: number } = {}) {
  const photoCount = options.photos ?? count;
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(memberPage[0]!),
    member: {
      ...structuredClone(memberPage[0]!.member),
      member_id: 1000 + index,
      bioguide_id: `X${String(index).padStart(6, '0')}`,
    },
    photos: index < photoCount ? structuredClone(memberPage[0]!.photos) : [],
    committees: structuredClone(memberPage[0]!.committees),
  }));
}

function staff(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(staffPage[0]!),
    staff: { ...structuredClone(staffPage[0]!.staff), id: 2000 + index },
  }));
}

function offices(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(officePage[0]!),
    office: { ...structuredClone(officePage[0]!.office), office_id: 3000 + index },
  }));
}

interface Collections {
  members: unknown[];
  staff: unknown[];
  offices: unknown[];
}

function healthy(): Collections {
  return { members: members(10), staff: staff(20), offices: offices(20) };
}

function baseline(active: Collections): DirectoryCurrentSnapshot {
  const prefix = 'UPDATED DIRECTORY/snapshots/active-current-20260501T024354Z';
  return {
    pointer: {
      schema_version: '2.0.0',
      snapshot_id: 'active-current-20260501T024354Z',
      snapshot_prefix: prefix,
      previous_snapshot_id: null,
      previous_snapshot_prefix: null,
      published_at: '2026-05-01T02:43:54.000Z',
      manifest_key: `${prefix}/manifest.json`,
      validation_key: `${prefix}/validation.json`,
      counts: {
        members: active.members.length,
        staff: active.staff.length,
        offices: active.offices.length,
      },
      checksums: {
        member_combined_sha256: 'member-sha',
        staff_combined_sha256: 'staff-sha',
        office_combined_sha256: 'office-sha',
      },
    },
    latestEtag: '"etag-baseline"',
    active,
    sourceObjects: {
      members: { key: 'm', sha256: 'member-sha', versionId: 'mv' },
      staff: { key: 's', sha256: 'staff-sha', versionId: 'sv' },
      offices: { key: 'o', sha256: 'office-sha', versionId: 'ov' },
    },
    overlays: {
      memberBios: {
        key: 'UPDATED DIRECTORY/overlays/member-bios-v1.json',
        sha256: 'bios-sha',
        versionId: 'bios-v',
      },
      memberPress: {
        key: 'UPDATED DIRECTORY/overlays/member-press-v1.json',
        sha256: 'press-sha',
        versionId: 'press-v',
      },
    },
  };
}

function makeStore(prev: Collections) {
  const publishInputs: DirectorySnapshotPublishInput[] = [];
  const snapshot = baseline(prev);
  const store: DirectorySnapshotStore = {
    loadCurrentSnapshot: async () => snapshot,
    publish: async (input) => {
      publishInputs.push(input);
      return { pointer: snapshot.pointer, manifest: {} };
    },
  };
  return { store, publishInputs };
}

function makeClient(
  incoming: Collections,
  retired: { office: number[]; staff: number[] } = { office: [], staff: [] },
) {
  const ranges: { members?: unknown; offices?: unknown; staff?: unknown } = {};
  const client: LegiStormSource = {
    fetchMembers: async (range) => {
      ranges.members = range;
      return { records: incoming.members as never, rawPages: [{ page: 1, body: incoming.members }] };
    },
    fetchOffices: async (range) => {
      ranges.offices = range;
      return { records: incoming.offices as never, rawPages: [{ page: 1, body: incoming.offices }] };
    },
    fetchStaff: async (range) => {
      ranges.staff = range;
      return { records: incoming.staff as never, rawPages: [{ page: 1, body: incoming.staff }] };
    },
    fetchRetiredOfficeIds: async () => ({ ids: retired.office, rawBody: retired.office }),
    fetchRetiredStaffIds: async () => ({ ids: retired.staff, rawBody: retired.staff }),
  };
  return { client, ranges };
}

function makePrisma(options: { watermark?: Date | null; forbidWrites?: boolean } = {}) {
  const writes = { created: 0, updated: [] as { data?: { status?: string } }[] };
  const watermark = options.watermark ?? null;
  const prisma: SyncRunCapablePrisma = {
    syncRun: {
      findFirst: async (args: unknown) => {
        const status = (args as { where?: { status?: string } })?.where?.status;
        if (status === 'success') return watermark ? { startedAt: watermark } : null;
        return null; // no active running run
      },
      create: async () => {
        if (options.forbidWrites) throw new Error('database write during dry run');
        writes.created += 1;
        return { id: 'run-1' };
      },
      update: async (args: unknown) => {
        if (options.forbidWrites) throw new Error('database write during dry run');
        writes.updated.push(args as { data?: { status?: string } });
      },
    },
  };
  return { prisma, writes };
}

describe('runSyncLegistormDirectory', () => {
  test('dry run reads only, publishes nothing, and never writes to the database', async () => {
    const { store, publishInputs } = makeStore(healthy());
    const { client, ranges } = makeClient(healthy());
    const { prisma, writes } = makePrisma({ watermark: WATERMARK, forbidWrites: true });
    const logs: string[] = [];

    const result = await runSyncLegistormDirectory(
      { client, store, prisma, now: NOW, overlapDays: 2, log: (m) => logs.push(m) },
      { commit: false, full: false, since: null },
    );

    expect(result.committed).toBe(false);
    expect(result.published).toBeNull();
    expect(publishInputs).toHaveLength(0);
    expect(writes.created).toBe(0);
    expect(writes.updated).toHaveLength(0);
    expect(result.plan.validation.valid).toBe(true);
    // members = full current list; staff/offices = watermark minus 2-day overlap
    expect(ranges.members).toEqual({ updatedFrom: DEFAULT_FULL_FLOOR_DATE, updatedTo: '2026-07-13' });
    expect(ranges.staff).toEqual({ updatedFrom: '2026-07-08', updatedTo: '2026-07-13' });
    expect(ranges.offices).toEqual({ updatedFrom: '2026-07-08', updatedTo: '2026-07-13' });
  });

  test('commit publishes when validation passes and records a successful run', async () => {
    const { store, publishInputs } = makeStore(healthy());
    const { client } = makeClient(healthy());
    const { prisma, writes } = makePrisma({ watermark: WATERMARK });

    const result = await runSyncLegistormDirectory(
      { client, store, prisma, now: NOW, overlapDays: 2 },
      { commit: true, full: false, since: null },
    );

    expect(result.committed).toBe(true);
    expect(result.published).not.toBeNull();
    expect(publishInputs).toHaveLength(1);
    expect(publishInputs[0]!.snapshotId).toBe('active-current-20260713T183045Z');
    expect(publishInputs[0]!.baseline).toEqual({
      snapshotId: 'active-current-20260501T024354Z',
      latestEtag: '"etag-baseline"',
    });
    // publish receives the merged active set and the exact validation report we computed
    expect(publishInputs[0]!.active).toBe(result.plan.merge.active);
    expect(publishInputs[0]!.validation).toBe(result.plan.validation);
    expect(writes.created).toBe(1);
    expect(writes.updated.some((u) => u.data?.status === 'success')).toBe(true);
  });

  test('commit does not publish and records an error when validation fails', async () => {
    // Member count 10 -> 8 is a 0.80 ratio, below the 0.90 floor, with no approval.
    const { store, publishInputs } = makeStore(healthy());
    const { client } = makeClient({ members: members(8), staff: staff(20), offices: offices(20) });
    const { prisma, writes } = makePrisma({ watermark: WATERMARK });

    await expect(
      runSyncLegistormDirectory(
        { client, store, prisma, now: NOW, overlapDays: 2 },
        { commit: true, full: false, since: null },
      ),
    ).rejects.toThrow(/validation failed/i);

    expect(publishInputs).toHaveLength(0);
    expect(writes.updated.some((u) => u.data?.status === 'error')).toBe(true);
  });

  test('full mode fetches every collection from the documented floor', async () => {
    const { store } = makeStore(healthy());
    const { client, ranges } = makeClient(healthy());
    const { prisma } = makePrisma({ watermark: WATERMARK, forbidWrites: true });

    const result = await runSyncLegistormDirectory(
      { client, store, prisma, now: NOW, overlapDays: 2 },
      { commit: false, full: true, since: null },
    );

    expect(result.plan.mode).toBe('full');
    const floor = { updatedFrom: DEFAULT_FULL_FLOOR_DATE, updatedTo: '2026-07-13' };
    expect(ranges.members).toEqual(floor);
    expect(ranges.staff).toEqual(floor);
    expect(ranges.offices).toEqual(floor);
  });

  test('explicit --since wins over the watermark and applies no overlap', async () => {
    const { store } = makeStore(healthy());
    const { client, ranges } = makeClient(healthy());
    const { prisma } = makePrisma({ watermark: WATERMARK, forbidWrites: true });

    await runSyncLegistormDirectory(
      { client, store, prisma, now: NOW, overlapDays: 2 },
      { commit: false, full: false, since: '2026-06-01' },
    );

    expect(ranges.staff).toEqual({ updatedFrom: '2026-06-01', updatedTo: '2026-07-13' });
    expect(ranges.members).toEqual({ updatedFrom: DEFAULT_FULL_FLOOR_DATE, updatedTo: '2026-07-13' });
  });

  test('summary output is aggregate-only and free of source PII', async () => {
    const { store } = makeStore(healthy());
    const { client } = makeClient(healthy());
    const { prisma } = makePrisma({ watermark: WATERMARK, forbidWrites: true });
    const logs: string[] = [];

    await runSyncLegistormDirectory(
      { client, store, prisma, now: NOW, overlapDays: 2, log: (m) => logs.push(m) },
      { commit: false, full: false, since: null },
    );

    const output = logs.join('\n');
    expect(output).toContain('SYNC_LEGISTORM_SUMMARY');
    expect(output).toContain('active-current-20260713T183045Z');
    expect(output).toMatch(/member-count/);
    expect(output).not.toContain('Alex'); // fixture given name
    expect(output).not.toContain('example.invalid'); // fixture contact host
  });
});

describe('parseArgs', () => {
  test('reads flags, --since, and --approval-file', () => {
    expect(parseArgs(['node', 'script', '--commit', '--since=2026-06-01'])).toEqual({
      commit: true,
      full: false,
      since: '2026-06-01',
      approvalFile: null,
    });
    expect(parseArgs(['node', 'script', '--full', '--approval-file=/tmp/a.json'])).toEqual({
      commit: false,
      full: true,
      since: null,
      approvalFile: '/tmp/a.json',
    });
  });
});
