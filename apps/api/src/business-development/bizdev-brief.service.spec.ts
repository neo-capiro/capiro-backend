import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { BizDevBriefService } from './bizdev-brief.service.js';
import type { EvidenceItem } from './bizdev-evidence.types.js';
import { generateSections } from './bizdev-brief.util.js';
import type { BriefCitation, BriefSections, BriefSourceSnapshot } from './bizdev-brief.types.js';

/**
 * Deterministic Jest coverage for the Phase 4 brief service with an
 * in-memory repository harness (repository test pattern, mirrors the
 * dossier service spec). RLS and true transactional behavior are NOT
 * claimed here — the persistence contract spec + disposable Postgres
 * harness own those. These tests pin: idempotent replay, idempotency
 * mismatch conflicts, stale-edit conflicts, refresh-preview no-write,
 * refresh accept, citation mismatch rejection, and tenant-safe 404s.
 */

const tenantId = randomUUID();
const tenantBId = randomUUID();
const ctx = { tenantId, userId: 'u1', role: 'standard_user' } as unknown as TenantContext;
const ctxB = { tenantId: tenantBId, userId: 'u2', role: 'standard_user' } as unknown as TenantContext;

interface ProspectRow {
  id: string;
  tenantId: string;
  displayName: string;
  canonicalEntityId: string | null;
  status: string;
}

interface BriefRow {
  id: string;
  tenantId: string;
  prospectId: string;
  title: string;
  status: string;
  currentVersionId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface VersionRow {
  id: string;
  tenantId: string;
  briefId: string;
  versionNumber: number;
  sections: BriefSections;
  sectionsHash: string;
  sourceSnapshot: BriefSourceSnapshot;
  snapshotHash: string;
  citations: BriefCitation[];
  idempotencyKey: string;
  idempotencyOp: string;
  idempotencyFingerprint: string;
  createdByUserId: string | null;
  createdAt: Date;
}

const ev = (over: Partial<EvidenceItem> = {}): EvidenceItem =>
  ({
    sourceFamily: 'usaspending_award',
    recordId: 'AWD-1',
    originalSourceName: 'USAspending',
    originalSourceId: 'AWD-1',
    locator: 'https://example.test/awd-1',
    eventDate: '2026-01-15',
    sourceUpdatedAt: '2026-01-20',
    fetchedAt: '2026-02-01T00:00:00Z',
    title: 'Award for infrastructure work',
    relationshipStrength: 'direct',
    stage: 'obligated',
    claimType: 'government_exposure',
    ...over,
  }) as EvidenceItem;

const now = () => new Date();

function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    const rowValue = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in (value as object)) {
        if (!(value as { in: unknown[] }).in.includes(rowValue)) return false;
        continue;
      }
      if ('equals' in (value as object)) {
        if ((value as { equals: unknown }).equals !== rowValue) return false;
        continue;
      }
      // relation filter (e.g. brief: { prospectId }) — approximate: skip
      continue;
    }
    if (value !== rowValue) return false;
  }
  return true;
}

const makeHarness = (fixture: {
  prospects: ProspectRow[];
  briefs: BriefRow[];
  versions: VersionRow[];
  dossierEvidence: EvidenceItem[];
  insertFailOnce?: boolean;
}) => {
  const calls = {
    versionCreates: 0,
    versionUpdates: 0,
    briefUpdates: 0,
    briefCreates: 0,
  };

  const nextVersionNumber = (briefId: string) =>
    fixture.versions
      .filter((v) => v.briefId === briefId)
      .reduce((max, v) => Math.max(max, v.versionNumber), 0) + 1;

  const versionTx = {
    findFirst: jest.fn(async ({ where, select }: { where: Record<string, unknown>; select?: unknown }) => {
      const rows = fixture.versions.filter((v) => matches(where, v as unknown as Record<string, unknown>));
      const row = rows[0];
      if (!row) return null;
      if (select && (where as { brief?: unknown }).brief) return { ...row, brief: fixture.briefs.find((b) => b.id === row.briefId) };
      return { ...row };
    }),
    findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const briefId = (where.briefId_versionNumber as { briefId: string })?.briefId ?? (where.briefId as string);
      const vn = (where.briefId_versionNumber as { versionNumber: number })?.versionNumber ?? (where.versionNumber as number);
      const row = fixture.versions.find((v) => v.briefId === briefId && v.versionNumber === vn);
      return row ? { ...row } : null;
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (fixture.insertFailOnce) {
        fixture.insertFailOnce = false;
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          clientVersion: '5.22.0',
          code: 'P2002',
          meta: { target: ['idempotency_key'] },
        });
      }
      calls.versionCreates += 1;
      const briefId = data.briefId as string;
      const brief = fixture.briefs.find((b) => b.id === briefId)!;
      const versionNumber = data.versionNumber as number;
      if (fixture.versions.some((v) => v.briefId === briefId && v.versionNumber === versionNumber)) {
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          clientVersion: '5.22.0',
          code: 'P2002',
          meta: { target: ['version_number'] },
        });
      }
      if (fixture.versions.some((v) => v.briefId === briefId && v.idempotencyKey === data.idempotencyKey)) {
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          clientVersion: '5.22.0',
          code: 'P2002',
          meta: { target: ['idempotency_key'] },
        });
      }
      const row: VersionRow = {
        id: randomUUID(),
        tenantId: data.tenantId as string,
        briefId,
        versionNumber,
        sections: data.sections as BriefSections,
        sectionsHash: data.sectionsHash as string,
        sourceSnapshot: data.sourceSnapshot as BriefSourceSnapshot,
        snapshotHash: data.snapshotHash as string,
        citations: data.citations as BriefCitation[],
        idempotencyKey: data.idempotencyKey as string,
        idempotencyOp: data.idempotencyOp as string,
        idempotencyFingerprint: data.idempotencyFingerprint as string,
        createdByUserId: (data.createdByUserId as string) ?? null,
        createdAt: now(),
      };
      fixture.versions.push(row);
      // auto-apply the brief pointer update the service performs next
      brief.currentVersionId = row.id;
      brief.updatedAt = now();
      return { ...row };
    }),
  };

  const briefTx = {
    findFirst: jest.fn(async ({ where, select }: { where: Record<string, unknown>; select?: unknown }) => {
      const row = fixture.briefs.find((b) => matches(where, b as unknown as Record<string, unknown>));
      if (!row) return null;
      if (select && (select as Record<string, unknown>).currentVersion) {
        return {
          ...row,
          currentVersion: fixture.versions.find((v) => v.id === row.currentVersionId) ?? null,
        };
      }
      if (select && (select as Record<string, unknown>).versions) {
        return {
          ...row,
          versions: fixture.versions
            .filter((v) => v.briefId === row.id)
            .sort((a, b) => a.versionNumber - b.versionNumber),
        };
      }
      return { ...row };
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      calls.briefCreates += 1;
      const row: BriefRow = {
        id: randomUUID(),
        tenantId: data.tenantId as string,
        prospectId: data.prospectId as string,
        title: data.title as string,
        status: (data.status as string) ?? 'draft',
        currentVersionId: null,
        createdByUserId: (data.createdByUserId as string) ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      fixture.briefs.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      calls.briefUpdates += 1;
      const row = fixture.briefs.find((b) => b.id === where.id)!;
      if (data.title !== undefined) row.title = data.title as string;
      if (data.status !== undefined) row.status = data.status as string;
      if (data.currentVersionId !== undefined) row.currentVersionId = data.currentVersionId as string;
      row.updatedAt = now();
      return { ...row };
    }),
  };

  const txFor = (t: string) => ({
    $queryRaw: jest.fn(async () => [{ id: 'lock' }]),
    businessDevelopmentProspect: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = fixture.prospects.find(
          (p) => matches(where, p as unknown as Record<string, unknown>) && p.tenantId === t,
        );
        return row ? { ...row } : null;
      }),
    },
    businessDevelopmentBrief: briefTx,
    businessDevelopmentBriefVersion: versionTx,
  });

  const prisma = {
    withTenant: jest.fn(async (t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(txFor(t)),
    ),
  } as never;

  const dossier = {
    prospectDossier: jest.fn(async (c: TenantContext, prospectId: string) => {
      const p = fixture.prospects.find((x) => x.id === prospectId && x.tenantId === c.tenantId);
      if (!p) throw new NotFoundException('Prospect not found');
      const evidence = fixture.dossierEvidence;
      return {
        canonicalName: 'Acme LLC',
        canonicalEntityId: p.canonicalEntityId,
        identityBasis: 'uei_exact',
        sections: { awards: { evidence }, lobbying: { evidence: [] } },
      };
    }),
  } as never;

  const service = new BizDevBriefService(prisma, dossier);
  return { service, calls, fixture };
};

const prospect = (): ProspectRow => ({
  id: randomUUID(),
  tenantId,
  displayName: 'Acme LLC',
  canonicalEntityId: randomUUID(),
  status: 'active',
});

const evidence = [ev()];

const editedSections = (): BriefSections => {
  const s = generateSections({ identityName: 'Acme LLC', identityBasis: 'uei_exact', evidence });
  return {
    ...s,
    judgment: { text: 'Manually weighed: promising.', provenance: 'edited', citationIndexes: [0] },
  } as BriefSections;
};

// ── createInitialVersion ────────────────────────────────────────────────────

describe('createInitialVersion', () => {
  test('creates root + version 1 (created: true)', async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    const out = await h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'key-0001' });
    expect(out.created).toBe(true);
    expect(out.version.versionNumber).toBe(1);
    expect(out.brief.currentVersionId).toBe(out.version.id);
    expect(h.calls.versionCreates).toBe(1);
  });

  test('idempotent retry: same key + same content replays the same version', async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    const first = await h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'key-0001' });
    const retry = await h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'key-0001' });
    expect(retry.created).toBe(false);
    expect(retry.version.id).toBe(first.version.id);
    expect(h.calls.versionCreates).toBe(1);
  });

  test('same key + different title (create) → explicit idempotency conflict, no write', async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    await h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'key-0001' });
    await expect(
      h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'key-0001', title: 'Different' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'BIZDEV_BRIEF_IDEMPOTENCY_MISMATCH' },
    });
    expect(h.calls.versionCreates).toBe(1);
  });

  test('cross-tenant prospect id → safe 404, no writes', async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    await expect(
      h.service.createInitialVersion(ctxB, p.id, { idempotencyKey: 'key-0001' }),
    ).rejects.toThrow(NotFoundException);
    expect(h.calls.versionCreates).toBe(0);
    expect(h.calls.briefCreates).toBe(0);
  });
});

// ── saveEditedVersion ───────────────────────────────────────────────────────

describe('saveEditedVersion', () => {
  const setup = async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    await h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'create-1' });
    return { p, h };
  };

  test('stale expectedVersionNumber → typed conflict carrying the latest version, no write', async () => {
    const { p, h } = await setup();
    // bump to v2 first
    await h.service.saveEditedVersion(ctx, p.id, {
      idempotencyKey: 'edit-1',
      expectedVersionNumber: 1,
      sections: editedSections(),
    });
    // now a stale save still expecting v1
    await expect(
      h.service.saveEditedVersion(ctx, p.id, {
        idempotencyKey: 'edit-2',
        expectedVersionNumber: 1,
        sections: editedSections(),
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'BIZDEV_BRIEF_VERSION_CONFLICT', latestVersion: { versionNumber: 2 } },
    });
    expect(h.calls.versionCreates).toBe(2);
  });

  test('idempotent retry of the same edit replays; different content conflicts', async () => {
    const { p, h } = await setup();
    const saved = await h.service.saveEditedVersion(ctx, p.id, {
      idempotencyKey: 'edit-1',
      expectedVersionNumber: 1,
      sections: editedSections(),
    });
    expect(saved.created).toBe(true);
    const retry = await h.service.saveEditedVersion(ctx, p.id, {
      idempotencyKey: 'edit-1',
      expectedVersionNumber: 1,
      sections: editedSections(),
    });
    expect(retry.created).toBe(false);
    expect(retry.version.id).toBe(saved.version.id);
    expect(h.calls.versionCreates).toBe(2);

    // same key, different sections → explicit mismatch conflict
    const other = { ...editedSections(), judgment: { ...editedSections().judgment, text: 'Different text.' } } as BriefSections;
    await expect(
      h.service.saveEditedVersion(ctx, p.id, {
        idempotencyKey: 'edit-1',
        expectedVersionNumber: 1,
        sections: other,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'BIZDEV_BRIEF_IDEMPOTENCY_MISMATCH' },
    });
  });

  test('fabricated inline citation field is rejected before any write', async () => {
    const { p, h } = await setup();
    const badSections = { ...editedSections() } as Record<string, unknown>;
    // attach a citation-shaped object with a fabricated record id
    const cite = {
      ...h.fixture.versions[0]!.citations[0]!,
      recordId: 'AWD-999',
    };
    (badSections.judgment as { citations?: unknown[] }).citations = [cite];
    await expect(
      h.service.saveEditedVersion(ctx, p.id, {
        idempotencyKey: 'edit-bad',
        expectedVersionNumber: 1,
        sections: badSections,
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'BIZDEV_BRIEF_SECTIONS_INVALID' },
    });
    expect(h.calls.versionCreates).toBe(1);
  });

  test('no brief yet → 404', async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    await expect(
      h.service.saveEditedVersion(ctx, p.id, {
        idempotencyKey: 'edit-x',
        expectedVersionNumber: 1,
        sections: editedSections(),
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ── refresh: preview no-write, explicit accept ─────────────────────────────

describe('refresh proposal + accept', () => {
  const setup = async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    await h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'create-1' });
    return { p, h };
  };

  test('buildRefreshProposal never writes', async () => {
    const { p, h } = await setup();
    const before = { ...h.calls };
    const proposal = await h.service.buildRefreshProposal(ctx, p.id);
    expect(proposal.baseVersionNumber).toBe(1);
    expect(proposal.diff).toHaveLength(5);
    expect(proposal.sourceSnapshot.evidence[0]!.recordId).toBe('AWD-1');
    expect(h.calls.versionCreates).toBe(before.versionCreates);
    expect(h.calls.briefUpdates).toBe(before.briefUpdates);
  });

  test('accept creates a new version with expected-version + idempotency checks', async () => {
    const { p, h } = await setup();
    const accepted = await h.service.acceptRefreshProposal(ctx, p.id, {
      idempotencyKey: 'accept-1',
      expectedVersionNumber: 1,
    });
    expect(accepted.created).toBe(true);
    expect(accepted.version.versionNumber).toBe(2);

    // retry replays
    const retry = await h.service.acceptRefreshProposal(ctx, p.id, {
      idempotencyKey: 'accept-1',
      expectedVersionNumber: 1,
    });
    expect(retry.created).toBe(false);
    expect(retry.version.id).toBe(accepted.version.id);
    expect(h.calls.versionCreates).toBe(2);

    // stale expected version → conflict
    await expect(
      h.service.acceptRefreshProposal(ctx, p.id, {
        idempotencyKey: 'accept-2',
        expectedVersionNumber: 1,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'BIZDEV_BRIEF_VERSION_CONFLICT', latestVersion: { versionNumber: 2 } },
    });

    // key reuse for a different operation (edit vs accept) → explicit conflict
    await expect(
      h.service.acceptRefreshProposal(ctx, p.id, {
        idempotencyKey: 'accept-1',
        expectedVersionNumber: 2,
        keepUserEdits: false,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'BIZDEV_BRIEF_IDEMPOTENCY_MISMATCH' },
    });
  });
});

// ── getVersion / cross-tenant reads ────────────────────────────────────────

describe('getVersion tenant safety', () => {
  test("another tenant's prospect id → safe 404", async () => {
    const p = prospect();
    const h = makeHarness({ prospects: [p], briefs: [], versions: [], dossierEvidence: evidence });
    await h.service.createInitialVersion(ctx, p.id, { idempotencyKey: 'create-1' });
    await expect(h.service.getVersion(ctxB, p.id, 1)).rejects.toThrow(NotFoundException);
    await expect(h.service.getCurrentBrief(ctxB, p.id)).rejects.toThrow(NotFoundException);
  });
});
