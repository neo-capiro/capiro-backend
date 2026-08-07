import { BadRequestException } from '@nestjs/common';
import {
  CHECKPOINT_COMPLETENESS,
  CONFIDENCE_BANDS,
  LINK_BASES,
  LINK_STATUSES,
  LOCAL_LINK_RESOURCE_TYPES,
  TangoSecretDetectedError,
  TangoStoreService,
  USAGE_STATUSES,
  assertNoSecretsIn,
  canonicalize,
  computeContentHash,
  computeFilterFingerprint,
  sha256Hex,
} from './tango-store.service.js';
import { TANGO_RESOURCE_TYPES } from './tango.types.js';

/**
 * Provider-owned persistence.
 *
 * A DELIBERATE, faithful in-memory double of the four tables, not a set of
 * one-off jest mocks — the versioned-head logic branches on what a prior call
 * left behind, so the double has to behave like the database across a
 * SEQUENCE of calls, not just answer one query at a time. Constraint-level
 * proof (the CHECKs, the partial unique indexes, RLS absence) is a separate
 * migration rehearsal against real Postgres; this file proves the SERVICE's
 * branching logic.
 */

interface SnapshotRow {
  id: string;
  resourceType: string;
  externalId: string;
  schemaVersion: number;
  sourceUpdatedAt: Date | null;
  providerFetchedAt: Date;
  sourceUrl: string | null;
  contentSha256: string;
  normalizedJsonb: unknown;
  active: boolean;
  version: number;
  supersededAt: Date | null;
}

interface LinkRow {
  id: string;
  localResourceType: string;
  localResourceId: string;
  tangoResourceType: string;
  tangoExternalId: string;
  basis: string;
  status: string;
  confidenceBand: string;
  conflictState: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
}

interface CheckpointRow {
  id: string;
  syncVerb: string;
  resourceType: string;
  filterFingerprint: string;
  cursor: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  completeness: string;
  rowsProcessed: number;
  lastRunAt: Date | null;
}

let nextId = 1;
const freshId = () => `id-${nextId++}`;

function makeFakePrisma() {
  const snapshots: SnapshotRow[] = [];
  const links: LinkRow[] = [];
  const checkpoints: CheckpointRow[] = [];
  const usage: Array<Record<string, unknown>> = [];

  const tx = {
    tangoResourceSnapshot: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.resourceType_externalId_contentSha256;
        return (
          snapshots.find(
            (s) =>
              s.resourceType === k.resourceType &&
              s.externalId === k.externalId &&
              s.contentSha256 === k.contentSha256,
          ) ?? null
        );
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          snapshots.find(
            (s) =>
              s.resourceType === where.resourceType &&
              s.externalId === where.externalId &&
              s.active === where.active,
          ) ?? null
        );
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return snapshots
          .filter((s) => s.resourceType === where.resourceType && s.externalId === where.externalId)
          .sort((a, b) => a.version - b.version);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = snapshots.find((s) => s.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row: SnapshotRow = {
          id: freshId(),
          resourceType: data.resourceType,
          externalId: data.externalId,
          schemaVersion: data.schemaVersion,
          sourceUpdatedAt: data.sourceUpdatedAt,
          providerFetchedAt: data.providerFetchedAt,
          sourceUrl: data.sourceUrl,
          contentSha256: data.contentSha256,
          normalizedJsonb: data.normalizedJsonb,
          active: data.active,
          version: data.version,
          supersededAt: null,
        };
        snapshots.push(row);
        return row;
      }),
    },
    tangoResourceLink: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.localResourceType_localResourceId_tangoResourceType_tangoExternalId;
        return (
          links.find(
            (l) =>
              l.localResourceType === k.localResourceType &&
              l.localResourceId === k.localResourceId &&
              l.tangoResourceType === k.tangoResourceType &&
              l.tangoExternalId === k.tangoExternalId,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row: LinkRow = {
          id: freshId(),
          localResourceType: data.localResourceType,
          localResourceId: data.localResourceId,
          tangoResourceType: data.tangoResourceType,
          tangoExternalId: data.tangoExternalId,
          basis: data.basis,
          status: data.status,
          confidenceBand: data.confidenceBand,
          conflictState: data.conflictState,
          reviewedBy: null,
          reviewedAt: null,
          reviewNotes: null,
        };
        links.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = links.find((l) => l.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return links.filter(
          (l) => l.tangoResourceType === where.tangoResourceType && l.tangoExternalId === where.tangoExternalId,
        );
      }),
    },
    tangoSyncCheckpoint: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.syncVerb_resourceType_filterFingerprint;
        return (
          checkpoints.find(
            (c) =>
              c.syncVerb === k.syncVerb &&
              c.resourceType === k.resourceType &&
              c.filterFingerprint === k.filterFingerprint,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row: CheckpointRow = {
          id: freshId(),
          syncVerb: data.syncVerb,
          resourceType: data.resourceType,
          filterFingerprint: data.filterFingerprint,
          cursor: data.cursor,
          windowStart: data.windowStart,
          windowEnd: data.windowEnd,
          completeness: data.completeness,
          rowsProcessed: data.rowsProcessed,
          lastRunAt: data.lastRunAt,
        };
        checkpoints.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = checkpoints.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
    },
    tangoApiUsage: {
      create: jest.fn(async ({ data }: any) => {
        usage.push(data);
        return { id: freshId(), ...data };
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const since: Date = where.timestampBucket.gte;
        return usage
          .filter((u) => (u.timestampBucket as Date) >= since)
          .map((u) => ({ callFamily: u.callFamily, status: u.status, timestampBucket: u.timestampBucket }));
      }),
    },
  };

  const prisma: any = {
    ...tx,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return { prisma, snapshots, links, checkpoints, usage };
}

function service() {
  const fake = makeFakePrisma();
  return { service: new TangoStoreService(fake.prisma), ...fake };
}

const ENTITY = {
  resourceType: 'entity' as const,
  externalId: 'ZZTESTUEI001',
  sourceUpdatedAt: '2026-08-01T00:00:00.000Z',
  normalized: { uei: 'ZZTESTUEI001', legalBusinessName: 'Synthetic Turbine Works LLC' },
};

beforeEach(() => {
  nextId = 1;
});

// ── Canonicalization and hashing ────────────────────────────────────────────

describe('canonicalization makes key order invisible', () => {
  test('two objects differing only in key order canonicalize identically', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { a: 2, c: { x: 2, y: 1 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test('array ORDER is preserved — it is data, not noise', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  test('the content hash is therefore stable under key reordering', () => {
    const a = { uei: 'X', naicsCodes: ['1', '2'] };
    const b = { naicsCodes: ['1', '2'], uei: 'X' };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  test('the content hash CHANGES when array order changes', () => {
    const a = { naicsCodes: ['1', '2'] };
    const b = { naicsCodes: ['2', '1'] };
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  test('the hash is lower-case hex, 64 characters — matches the CHECK constraint', () => {
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the filter fingerprint uses the SAME canonicalization, so callers agree', () => {
    const a = computeFilterFingerprint({ fiscalYear: 2027, naics: '336412' });
    const b = computeFilterFingerprint({ naics: '336412', fiscalYear: 2027 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Secret scrubbing ─────────────────────────────────────────────────────────

describe('a secret-shaped value is REFUSED, not redacted-and-continued', () => {
  test('a key-named field throws, naming its path', () => {
    expect(() => assertNoSecretsIn({ apiKey: 'x' })).toThrow(TangoSecretDetectedError);
    expect(() => assertNoSecretsIn({ apiKey: 'x' })).toThrow(/\$\.apiKey/);
  });

  test('a nested key-named field is still caught', () => {
    expect(() => assertNoSecretsIn({ profile: { authorization: 'Bearer x' } })).toThrow(
      TangoSecretDetectedError,
    );
  });

  test('a key-SHAPED value with an innocuous field name is still caught', () => {
    // The whole point: a secret can arrive under a field name that gives no hint,
    // and only the VALUE'S shape gives it away.
    expect(() => assertNoSecretsIn({ note: 'sk_live_abcdefghijklmnop' })).toThrow(
      TangoSecretDetectedError,
    );
  });

  test('an ordinary business payload passes clean', () => {
    expect(() => assertNoSecretsIn(ENTITY.normalized)).not.toThrow();
  });

  test('writeSnapshot refuses to write a payload containing a secret-shaped value', async () => {
    const { service: svc } = service();
    await expect(
      svc.writeSnapshot({ ...ENTITY, normalized: { ...ENTITY.normalized, apiKey: 'x' } }),
    ).rejects.toBeInstanceOf(TangoSecretDetectedError);
  });

  test('the check is depth-bounded, so a hostile payload cannot hang it', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 30; i += 1) deep = { next: deep };
    expect(() => assertNoSecretsIn(deep)).not.toThrow();
  });
});

// ── The versioned-head policy ────────────────────────────────────────────────

describe('writeSnapshot: the versioned-head policy', () => {
  test('the first observation of a resource is created as version 1, active', async () => {
    const { service: svc, snapshots } = service();
    const result = await svc.writeSnapshot(ENTITY);
    expect(result.created).toBe(true);
    expect(result.version).toBe(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.active).toBe(true);
  });

  test('an EXACT repeat is a true no-op — nothing new is written', async () => {
    const { service: svc, snapshots } = service();
    await svc.writeSnapshot(ENTITY);
    const second = await svc.writeSnapshot(ENTITY);
    expect(second.created).toBe(false);
    expect(second.version).toBe(1);
    expect(snapshots).toHaveLength(1); // still just the one row
  });

  test('CHANGED content supersedes the old head and becomes version 2', async () => {
    const { service: svc, snapshots } = service();
    const first = await svc.writeSnapshot(ENTITY);
    const second = await svc.writeSnapshot({
      ...ENTITY,
      normalized: { ...ENTITY.normalized, legalBusinessName: 'Renamed LLC' },
    });
    expect(second.created).toBe(true);
    expect(second.version).toBe(2);
    expect(snapshots).toHaveLength(2);

    const superseded = snapshots.find((s) => s.id === first.id)!;
    expect(superseded.active).toBe(false);
    expect(superseded.supersededAt).not.toBeNull();

    const head = snapshots.find((s) => s.id === second.id)!;
    expect(head.active).toBe(true);
  });

  test('at most ONE row is active per resource after several changes', async () => {
    const { service: svc, snapshots } = service();
    for (let i = 0; i < 4; i += 1) {
      await svc.writeSnapshot({ ...ENTITY, normalized: { ...ENTITY.normalized, rev: i } });
    }
    const active = snapshots.filter((s) => s.active);
    expect(active).toHaveLength(1);
    expect(active[0]!.version).toBe(4);
  });

  test('a superseded row is never mutated again except by the ONE supersession write', async () => {
    // "Immutable once written" — the core content columns never change.
    const { service: svc, snapshots } = service();
    const first = await svc.writeSnapshot(ENTITY);
    const before = { ...snapshots.find((s) => s.id === first.id)! };
    await svc.writeSnapshot({ ...ENTITY, normalized: { ...ENTITY.normalized, rev: 1 } });
    const after = snapshots.find((s) => s.id === first.id)!;
    expect(after.contentSha256).toBe(before.contentSha256);
    expect(after.normalizedJsonb).toEqual(before.normalizedJsonb);
    expect(after.providerFetchedAt).toBe(before.providerFetchedAt);
  });

  test('two DIFFERENT resources never interfere with each others history', async () => {
    const { service: svc, snapshots } = service();
    await svc.writeSnapshot(ENTITY);
    await svc.writeSnapshot({
      resourceType: 'entity',
      externalId: 'ZZTESTUEI002',
      sourceUpdatedAt: null,
      normalized: { uei: 'ZZTESTUEI002' },
    });
    expect(snapshots.filter((s) => s.active)).toHaveLength(2);
  });

  test('the SAME external id under a DIFFERENT resource type is a different resource', async () => {
    // The natural key is (resourceType, externalId) TOGETHER — a collision on the
    // id alone across two different provider record types must not merge them.
    const { service: svc, snapshots } = service();
    await svc.writeSnapshot({ ...ENTITY, resourceType: 'entity', externalId: 'SAME-ID' });
    await svc.writeSnapshot({ ...ENTITY, resourceType: 'forecast', externalId: 'SAME-ID' });
    expect(snapshots.filter((s) => s.active)).toHaveLength(2);
  });

  test('an unknown resource type is refused before anything is written', async () => {
    const { service: svc, snapshots } = service();
    await expect(
      svc.writeSnapshot({ ...ENTITY, resourceType: 'fpds' as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(snapshots).toHaveLength(0);
  });

  test('null sourceUpdatedAt is preserved as null, not substituted with fetchedAt', async () => {
    const { service: svc, snapshots } = service();
    await svc.writeSnapshot({ ...ENTITY, sourceUpdatedAt: null });
    expect(snapshots[0]!.sourceUpdatedAt).toBeNull();
  });

  test('every real TANGO_RESOURCE_TYPE is writable', async () => {
    const { service: svc } = service();
    for (const resourceType of TANGO_RESOURCE_TYPES) {
      const result = await svc.writeSnapshot({
        resourceType,
        externalId: `id-for-${resourceType}`,
        sourceUpdatedAt: null,
        normalized: { marker: resourceType },
      });
      expect(result.created).toBe(true);
    }
  });
});

describe('getActiveSnapshot / getSnapshotHistory', () => {
  test('getActiveSnapshot returns null before anything has been observed', async () => {
    const { service: svc } = service();
    expect(await svc.getActiveSnapshot('entity', 'nope')).toBeNull();
  });

  test('getSnapshotHistory returns every version, oldest first', async () => {
    const { service: svc } = service();
    await svc.writeSnapshot(ENTITY);
    await svc.writeSnapshot({ ...ENTITY, normalized: { ...ENTITY.normalized, rev: 1 } });
    await svc.writeSnapshot({ ...ENTITY, normalized: { ...ENTITY.normalized, rev: 2 } });
    const history = await svc.getSnapshotHistory(ENTITY.resourceType, ENTITY.externalId);
    expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
  });
});

// ── Links ────────────────────────────────────────────────────────────────────

const LINK_INPUT = {
  localResourceType: 'sam_opportunity' as const,
  localResourceId: 'sam-opp-1',
  tangoResourceType: 'opportunity' as const,
  tangoExternalId: 'tango-opp-1',
  basis: 'exact_identifier' as const,
  confidenceBand: 'high' as const,
};

describe('proposeLink is idempotent and never resurrects a rejection', () => {
  test('the first proposal creates an active link', async () => {
    const { service: svc, links } = service();
    const link = await svc.proposeLink(LINK_INPUT);
    expect(link.status).toBe('active');
    expect(links).toHaveLength(1);
  });

  test('re-proposing the SAME pair returns the existing row, creating nothing new', async () => {
    const { service: svc, links } = service();
    const first = await svc.proposeLink(LINK_INPUT);
    const second = await svc.proposeLink(LINK_INPUT);
    expect(second.id).toBe(first.id);
    expect(links).toHaveLength(1);
  });

  test('a REJECTED link is never resurrected by a repeat proposal', async () => {
    const { service: svc } = service();
    const link = await svc.proposeLink(LINK_INPUT);
    await svc.reviewLink(link.id, { status: 'rejected', reviewedBy: 'user-1' });
    const reproposed = await svc.proposeLink(LINK_INPUT);
    expect(reproposed.status).toBe('rejected');
  });

  test('an unsupported local resource type is refused', async () => {
    const { service: svc } = service();
    await expect(
      svc.proposeLink({ ...LINK_INPUT, localResourceType: 'client' as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('a TENANT resource is explicitly named as unsupported, not just rejected silently', async () => {
    const { service: svc } = service();
    await expect(
      svc.proposeLink({ ...LINK_INPUT, localResourceType: 'client_funding_opportunity' as any }),
    ).rejects.toThrow(/tenant-owned resource is never valid/);
  });

  test('every real LOCAL_LINK_RESOURCE_TYPE is accepted', async () => {
    const { service: svc } = service();
    for (const localResourceType of LOCAL_LINK_RESOURCE_TYPES) {
      const link = await svc.proposeLink({ ...LINK_INPUT, localResourceType, localResourceId: `x-${localResourceType}` });
      expect(link.localResourceType).toBe(localResourceType);
    }
  });

  test('an unknown tango resource type is refused', async () => {
    const { service: svc } = service();
    await expect(
      svc.proposeLink({ ...LINK_INPUT, tangoResourceType: 'fpds_award' as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('reviewLink is a deliberate human action, and MAY reverse a rejection', () => {
  test('rejecting stamps the actor and timestamp', async () => {
    const { service: svc } = service();
    const link = await svc.proposeLink(LINK_INPUT);
    const reviewed = await svc.reviewLink(link.id, {
      status: 'rejected',
      reviewedBy: 'user-1',
      reviewNotes: 'Wrong entity.',
    });
    expect(reviewed.status).toBe('rejected');
    expect(reviewed.reviewedBy).toBe('user-1');
    expect(reviewed.reviewedAt).not.toBeNull();
    expect(reviewed.reviewNotes).toBe('Wrong entity.');
  });

  test('unlike proposeLink, reviewLink CAN move a rejected link back to active', async () => {
    // The distinction that matters: durability protects a decision from being
    // undone by AUTOMATION, not from being deliberately corrected by a human
    // reviewing it again.
    const { service: svc } = service();
    const link = await svc.proposeLink(LINK_INPUT);
    await svc.reviewLink(link.id, { status: 'rejected', reviewedBy: 'user-1' });
    const restored = await svc.reviewLink(link.id, { status: 'active', reviewedBy: 'user-2' });
    expect(restored.status).toBe('active');
    expect(restored.reviewedBy).toBe('user-2');
  });

  test('every review stamps a fresh reviewedAt, so "reviewed last" is always answerable', async () => {
    const { service: svc } = service();
    const link = await svc.proposeLink(LINK_INPUT);
    const firstReview = await svc.reviewLink(link.id, { status: 'active', reviewedBy: 'user-1' });
    const secondReview = await svc.reviewLink(link.id, { status: 'active', reviewedBy: 'user-2' });
    expect(secondReview.reviewedBy).toBe('user-2');
    expect(secondReview.reviewedAt!.getTime()).toBeGreaterThanOrEqual(
      firstReview.reviewedAt!.getTime(),
    );
  });
});

describe('link vocabulary is exactly what the schema constrains', () => {
  test.each([...LINK_BASES])('%s is a real basis', (b) => expect(typeof b).toBe('string'));
  test.each([...LINK_STATUSES])('%s is a real status', (s) => expect(typeof s).toBe('string'));
  test.each([...CONFIDENCE_BANDS])('%s is a real confidence band', (c) => expect(typeof c).toBe('string'));
  test('there are exactly two bases, and neither is a fuzzy match', () => {
    // Same invariant P02 enforced for award-history identity.
    expect(LINK_BASES).toEqual(['exact_identifier', 'reviewed_manual']);
  });
});

// ── Checkpoints ──────────────────────────────────────────────────────────────

describe('checkpoints resume by (verb, resource, filter), and rowsProcessed accumulates', () => {
  test('a fresh checkpoint is created on first write', async () => {
    const { service: svc, checkpoints } = service();
    await svc.writeCheckpoint({
      syncVerb: 'sync-tango-forecasts',
      resourceType: 'forecast',
      filterFingerprint: computeFilterFingerprint({ fiscalYear: 2027 }),
      cursor: 'CURSOR-1',
      rowsProcessed: 50,
    });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.rowsProcessed).toBe(50);
  });

  test('a second page ADDS to rowsProcessed rather than replacing it', async () => {
    const { service: svc, checkpoints } = service();
    const fp = computeFilterFingerprint({ fiscalYear: 2027 });
    await svc.writeCheckpoint({
      syncVerb: 'sync-tango-forecasts',
      resourceType: 'forecast',
      filterFingerprint: fp,
      rowsProcessed: 50,
    });
    await svc.writeCheckpoint({
      syncVerb: 'sync-tango-forecasts',
      resourceType: 'forecast',
      filterFingerprint: fp,
      cursor: 'CURSOR-2',
      rowsProcessed: 25,
    });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.rowsProcessed).toBe(75);
    expect(checkpoints[0]!.cursor).toBe('CURSOR-2');
  });

  test('DIFFERENT filters get an INDEPENDENT checkpoint, never sharing a cursor', async () => {
    const { service: svc, checkpoints } = service();
    await svc.writeCheckpoint({
      syncVerb: 'sync-tango-forecasts',
      resourceType: 'forecast',
      filterFingerprint: computeFilterFingerprint({ fiscalYear: 2027 }),
      cursor: 'CURSOR-2027',
    });
    await svc.writeCheckpoint({
      syncVerb: 'sync-tango-forecasts',
      resourceType: 'forecast',
      filterFingerprint: computeFilterFingerprint({ fiscalYear: 2028 }),
      cursor: 'CURSOR-2028',
    });
    expect(checkpoints).toHaveLength(2);
  });

  test('readCheckpoint returns null when the walk has never run', async () => {
    const { service: svc } = service();
    expect(
      await svc.readCheckpoint('sync-tango-forecasts', 'forecast', computeFilterFingerprint({})),
    ).toBeNull();
  });

  test('the cursor is carried verbatim, never parsed', async () => {
    const { service: svc } = service();
    const fp = computeFilterFingerprint({});
    await svc.writeCheckpoint({
      syncVerb: 'v',
      resourceType: 'entity',
      filterFingerprint: fp,
      cursor: 'op=eq;raw=%%%not-json%%%',
    });
    const read = await svc.readCheckpoint('v', 'entity', fp);
    expect(read!.cursor).toBe('op=eq;raw=%%%not-json%%%');
  });

  test.each([...CHECKPOINT_COMPLETENESS])('%s is accepted as a completeness value', async (completeness) => {
    const { service: svc, checkpoints } = service();
    await svc.writeCheckpoint({
      syncVerb: 'v',
      resourceType: 'entity',
      filterFingerprint: computeFilterFingerprint({ c: completeness }),
      completeness,
    });
    expect(checkpoints.at(-1)!.completeness).toBe(completeness);
  });

  test('an unknown resource type is refused', async () => {
    const { service: svc } = service();
    await expect(
      svc.writeCheckpoint({ syncVerb: 'v', resourceType: 'fpds' as any, filterFingerprint: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Usage ────────────────────────────────────────────────────────────────────

describe('recordUsage never forwards a header or a key', () => {
  test('a normal call records cleanly', async () => {
    const { service: svc, usage } = service();
    await svc.recordUsage({ callFamily: 'getEntity', status: 'success', durationMs: 42 });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ callFamily: 'getEntity', status: 'success', durationMs: 42 });
  });

  test('an unknown status is refused', async () => {
    const { service: svc } = service();
    await expect(
      svc.recordUsage({ callFamily: 'getEntity', status: 'teapot' as any, durationMs: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test.each([...USAGE_STATUSES])('%s is a valid usage status', async (status) => {
    const { service: svc, usage } = service();
    await svc.recordUsage({ callFamily: 'getEntity', status, durationMs: 1 });
    expect(usage.at(-1)!.status).toBe(status);
  });

  test('a caller widening its own type cannot smuggle a header or key through', async () => {
    // recordUsage builds its `data` object field-by-field; a caller that adds an
    // extra property to a loosely-typed input object cannot get it forwarded,
    // because nothing here spreads the input.
    const { service: svc, usage } = service();
    const hostile = {
      callFamily: 'getEntity',
      status: 'success' as const,
      durationMs: 1,
      apiKey: 'sk_live_should_not_reach_the_row',
      headers: { 'X-API-KEY': 'also-should-not-reach-the-row' },
    };
    await svc.recordUsage(hostile as any);
    expect(usage.at(-1)).not.toHaveProperty('apiKey');
    expect(usage.at(-1)).not.toHaveProperty('headers');
    expect(JSON.stringify(usage.at(-1))).not.toContain('should_not_reach_the_row');
  });

  test('rowCount and rate-limit fields are optional and default to null', async () => {
    const { service: svc, usage } = service();
    await svc.recordUsage({ callFamily: 'getVersion', status: 'success', durationMs: 5 });
    expect(usage.at(-1)!.rowCount).toBeNull();
    expect(usage.at(-1)!.rateLimitRemaining).toBeNull();
  });

  test('the timestamp is bucketed to the minute', async () => {
    const { service: svc, usage } = service();
    const at = new Date('2026-08-06T12:34:56.789Z');
    await svc.recordUsage({ callFamily: 'getVersion', status: 'success', durationMs: 1, at });
    const bucket = usage.at(-1)!.timestampBucket as Date;
    expect(bucket.toISOString()).toBe('2026-08-06T12:34:00.000Z');
  });
});

describe('getUsageHealth (P18): aggregates the persisted usage log, not live process state', () => {
  const ASOF = new Date('2026-08-07T00:00:00.000Z');

  test('with no rows in the window, totals are zero and successRate is NULL, not zero', async () => {
    const { service: svc } = service();
    const health = await svc.getUsageHealth(60, ASOF);
    expect(health.totalCalls).toBe(0);
    expect(health.byStatus).toEqual({});
    expect(health.successRate).toBeNull();
    expect(health.rateLimitHits).toBe(0);
    expect(health.mostRecentCallAt).toBeNull();
  });

  test('counts by status and by call family, over a mix of outcomes', async () => {
    const { service: svc } = service();
    await svc.recordUsage({ callFamily: 'getVersion', status: 'success', durationMs: 1, at: ASOF });
    await svc.recordUsage({ callFamily: 'listForecasts', status: 'success', durationMs: 1, at: ASOF });
    await svc.recordUsage({ callFamily: 'listForecasts', status: 'rate_limit', durationMs: 1, at: ASOF });
    await svc.recordUsage({ callFamily: 'listForecasts', status: 'rate_limit', durationMs: 1, at: ASOF });

    const health = await svc.getUsageHealth(60, ASOF);
    expect(health.totalCalls).toBe(4);
    expect(health.byStatus).toEqual({ success: 2, rate_limit: 2 });
    expect(health.byCallFamily.listForecasts).toEqual({ total: 3, byStatus: { success: 1, rate_limit: 2 } });
    expect(health.byCallFamily.getVersion).toEqual({ total: 1, byStatus: { success: 1 } });
    expect(health.rateLimitHits).toBe(2);
    expect(health.successRate).toBe(0.5);
  });

  test('a row older than the window is excluded', async () => {
    const { service: svc } = service();
    const old = new Date(ASOF.getTime() - 61 * 60_000);
    await svc.recordUsage({ callFamily: 'getVersion', status: 'success', durationMs: 1, at: old });
    const health = await svc.getUsageHealth(60, ASOF);
    expect(health.totalCalls).toBe(0);
  });

  test('a row exactly at the window boundary is included (inclusive lower bound)', async () => {
    const { service: svc } = service();
    const boundary = new Date(ASOF.getTime() - 60 * 60_000);
    await svc.recordUsage({ callFamily: 'getVersion', status: 'success', durationMs: 1, at: boundary });
    const health = await svc.getUsageHealth(60, ASOF);
    expect(health.totalCalls).toBe(1);
  });

  test('mostRecentCallAt is the latest bucketed timestamp in the window', async () => {
    const { service: svc } = service();
    await svc.recordUsage({
      callFamily: 'getVersion',
      status: 'success',
      durationMs: 1,
      at: new Date('2026-08-06T23:00:00.000Z'),
    });
    await svc.recordUsage({
      callFamily: 'getVersion',
      status: 'success',
      durationMs: 1,
      at: new Date('2026-08-06T23:55:00.000Z'),
    });
    const health = await svc.getUsageHealth(120, ASOF);
    expect(health.mostRecentCallAt).toBe('2026-08-06T23:55:00.000Z');
  });

  test('windowMinutes and since/asOf are echoed back for a self-describing report', async () => {
    const { service: svc } = service();
    const health = await svc.getUsageHealth(30, ASOF);
    expect(health.windowMinutes).toBe(30);
    expect(health.asOf).toBe(ASOF.toISOString());
    expect(health.since).toBe(new Date(ASOF.getTime() - 30 * 60_000).toISOString());
  });

  test('defaults to a 60-minute window and the real clock when called with no arguments', async () => {
    const { service: svc } = service();
    const before = Date.now();
    const health = await svc.getUsageHealth();
    expect(health.windowMinutes).toBe(60);
    expect(new Date(health.asOf).getTime()).toBeGreaterThanOrEqual(before);
  });

  test('a 100% failure window still divides correctly (successRate 0, not null)', async () => {
    const { service: svc } = service();
    await svc.recordUsage({ callFamily: 'getVersion', status: 'transient', durationMs: 1, at: ASOF });
    const health = await svc.getUsageHealth(60, ASOF);
    expect(health.successRate).toBe(0);
  });
});
