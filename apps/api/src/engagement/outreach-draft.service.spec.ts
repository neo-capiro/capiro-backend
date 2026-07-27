// Engagement Phase 0 (plan §3.b1) — immutable version creation + exact-version
// decisions.
//
// Stubs the withTenant tx surface the service touches (same pattern as
// outreach-job.spec.ts) so the state machine is pinned without a live database.
// The parts worth pinning: a version is APPENDED not mutated, numbering is taken
// under the artifact row lock, a stale edit is refused, an approval rewrites both
// lifecycle fields on ONE row, and a review that governs a different version
// cannot release this one.

import { describe, expect, jest, test } from '@jest/globals';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { OutreachDraftService, contentHashOf } from './outreach-draft.service.js';
import { OUTREACH_DRAFT_VERSION_SUBJECT_TYPE } from './outreach-draft.types.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

interface VersionRowSeed {
  id: string;
  version: number;
  auditStatus?: string;
  approvalStatus?: string;
  subject?: string;
  body?: string;
  contentHash?: string;
  generationStatus?: string;
}

interface Harness {
  service: OutreachDraftService;
  created: Array<Record<string, unknown>>;
  artifactUpdates: Array<Record<string, unknown>>;
  versionUpdates: Array<Record<string, unknown>>;
  lockCalls: number;
  auditCalls: string[];
}

function makeHarness(opts: {
  recordOwner?: string | null;
  artifactCurrentVersion?: number;
  versions?: VersionRowSeed[];
  review?: { id: string; subjectId: string; subjectType: string; surface: string } | null;
  auditImpl?: (versionId: string) => Promise<unknown>;
}): Harness {
  const created: Array<Record<string, unknown>> = [];
  const artifactUpdates: Array<Record<string, unknown>> = [];
  const versionUpdates: Array<Record<string, unknown>> = [];
  const auditCalls: string[] = [];
  const h = { lockCalls: 0 };
  let versions = [...(opts.versions ?? [])];
  let currentVersion = opts.artifactCurrentVersion ?? 0;

  const tx = {
    outreachRecord: {
      findFirst: async () =>
        opts.recordOwner === null
          ? null
          : { id: 'rec-1', createdByUserId: opts.recordOwner ?? 'u1' },
    },
    outreachDraftArtifact: {
      // `versions` is included so loadArtifact() (used by acceptCandidateVersion's
      // return value) can resolve `current`/`history` without a separate mock —
      // real Prisma would only include it when `select.versions` is requested,
      // but this generic mock always includes it, which every caller tolerates.
      findFirst: async () => ({
        id: 'art-1',
        outreachRecordId: 'rec-1',
        generationKey: 'individual:a@x.com',
        recipientKey: 'a@x.com',
        audienceKind: 'individual',
        currentVersion,
        createdByUserId: 'u1',
        versions: [...versions]
          .sort((a, b) => b.version - a.version)
          .map((v) => ({
            id: v.id,
            tenantId: 't1',
            artifactId: 'art-1',
            version: v.version,
            sourceVersionId: null,
            subject: v.subject ?? 'S',
            body: v.body ?? 'B',
            contentHash: v.contentHash ?? contentHashOf(v.subject ?? 'S', v.body ?? 'B'),
            generationStatus: v.generationStatus ?? 'generated',
            auditStatus: v.auditStatus ?? 'pending',
            approvalStatus: v.approvalStatus ?? 'not_required',
            auditMode: null,
            auditDecision: null,
            auditFindings: null,
            auditLedger: [],
            reviewRequestId: null,
            contextPacketId: null,
            provider: null,
            model: null,
            promptSpecVersion: null,
            createdAt: new Date('2026-07-27T00:00:00Z'),
            artifact: {
              id: 'art-1',
              outreachRecordId: 'rec-1',
              generationKey: 'individual:a@x.com',
              recipientKey: 'a@x.com',
              audienceKind: 'individual',
              currentVersion,
              createdByUserId: 'u1',
            },
          })),
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push({ table: 'artifact', ...data });
        return { id: 'art-1' };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        artifactUpdates.push(data);
        currentVersion = Number(data.currentVersion);
        return {};
      },
    },
    outreachDraftVersion: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const byId = versions.find((v) => v.id === where.id);
        const byVersion =
          where.version != null ? versions.find((v) => v.version === where.version) : undefined;
        const row = byId ?? byVersion;
        if (!row) return null;
        return {
          id: row.id,
          tenantId: 't1',
          artifactId: 'art-1',
          version: row.version,
          sourceVersionId: null,
          subject: row.subject ?? 'S',
          body: row.body ?? 'B',
          contentHash: row.contentHash ?? contentHashOf(row.subject ?? 'S', row.body ?? 'B'),
          generationStatus: row.generationStatus ?? 'generated',
          auditStatus: row.auditStatus ?? 'pending',
          approvalStatus: row.approvalStatus ?? 'not_required',
          auditMode: null,
          auditDecision: null,
          auditFindings: null,
          auditLedger: [],
          reviewRequestId: null,
          contextPacketId: null,
          provider: 'anthropic',
          model: 'claude',
          promptSpecVersion: 'v2.1',
          createdAt: new Date('2026-07-27T00:00:00Z'),
          artifact: {
            id: 'art-1',
            outreachRecordId: 'rec-1',
            generationKey: 'individual:a@x.com',
            recipientKey: 'a@x.com',
            audienceKind: 'individual',
            currentVersion,
            createdByUserId: 'u1',
          },
        };
      },
      findMany: async () => [],
      // Phase 2 §3.f2 — candidate numbering reads MAX(version) across ALL
      // rows for the artifact, not just currentVersion, so a second
      // candidate offered before the first is accepted still gets a fresh,
      // non-colliding number.
      aggregate: async () => ({
        _max: { version: versions.length ? Math.max(...versions.map((v) => v.version)) : null },
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push({ table: 'version', ...data });
        versions.push({
          id: `v-${data.version}`,
          version: Number(data.version),
          auditStatus: String(data.auditStatus),
          approvalStatus: String(data.approvalStatus),
          subject: String(data.subject),
          body: String(data.body),
          generationStatus: String(data.generationStatus),
        });
        return {
          id: `v-${data.version}`,
          tenantId: 't1',
          artifactId: 'art-1',
          version: Number(data.version),
          sourceVersionId: (data.sourceVersionId as string) ?? null,
          subject: String(data.subject),
          body: String(data.body),
          contentHash: String(data.contentHash),
          generationStatus: String(data.generationStatus),
          auditStatus: String(data.auditStatus),
          approvalStatus: String(data.approvalStatus),
          auditMode: null,
          auditDecision: null,
          auditFindings: null,
          auditLedger: [],
          reviewRequestId: null,
          contextPacketId: null,
          provider: (data.provider as string) ?? null,
          model: (data.model as string) ?? null,
          promptSpecVersion: (data.promptSpecVersion as string) ?? null,
          createdAt: new Date('2026-07-27T00:00:00Z'),
          artifact: {
            id: 'art-1',
            outreachRecordId: 'rec-1',
            generationKey: 'individual:a@x.com',
            recipientKey: 'a@x.com',
            audienceKind: 'individual',
            currentVersion: Number(data.version),
            createdByUserId: 'u1',
          },
        };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        versionUpdates.push(data);
        versions = versions.map((v) =>
          v.id === 'v-1' || versions.length === 1
            ? {
                ...v,
                auditStatus: (data.auditStatus as string) ?? v.auditStatus,
                approvalStatus: (data.approvalStatus as string) ?? v.approvalStatus,
              }
            : v,
        );
        return { count: 1 };
      },
    },
    reviewRequest: {
      findFirst: async () => opts.review ?? null,
    },
    // Tagged-template $queryRaw: the FOR UPDATE artifact lock.
    $queryRaw: async () => {
      h.lockCalls++;
      return [{ current_version: currentVersion }];
    },
  };

  const service = Object.create(OutreachDraftService.prototype) as OutreachDraftService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.prisma = {
    withTenant: (_t: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  patch.audit = {
    runForVersion: async (_c: TenantContext, versionId: string) => {
      auditCalls.push(versionId);
      if (opts.auditImpl) return opts.auditImpl(versionId);
      return {
        versionId,
        auditStatus: 'passed',
        approvalStatus: 'not_required',
        auditMode: 'enforce',
        auditDecision: 'deliver',
        findingCount: 0,
        reviewRequestId: null,
      };
    },
  };

  return {
    service,
    created,
    artifactUpdates,
    versionUpdates,
    get lockCalls() {
      return h.lockCalls;
    },
    auditCalls,
  } as Harness;
}

const generatedInput = {
  outreachRecordId: 'rec-1',
  generationKey: 'individual:a@x.com',
  recipientKey: 'a@x.com',
  audienceKind: 'individual' as const,
  recipientSnapshot: { email: 'a@x.com' },
  subject: 'Hello',
  body: 'Body text',
};

describe('contentHashOf', () => {
  test('is deterministic and separates subject from body', () => {
    expect(contentHashOf('A', 'B')).toBe(contentHashOf('A', 'B'));
    expect(contentHashOf('AB', 'C')).not.toBe(contentHashOf('A', 'BC'));
    expect(contentHashOf('A', 'B')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('upsertGeneratedVersion', () => {
  test('takes the artifact row lock, then creates version currentVersion+1 as PENDING', async () => {
    const h = makeHarness({ artifactCurrentVersion: 0 });
    const dto = await h.service.upsertGeneratedVersion(ctx, generatedInput);
    expect(h.lockCalls).toBe(1); // SELECT ... FOR UPDATE happened
    const version = h.created.find((c) => c.table === 'version')!;
    expect(version.version).toBe(1);
    // Created NON-sendable: only the post-commit audit can release it.
    expect(version.auditStatus).toBe('pending');
    expect(h.artifactUpdates).toEqual([{ currentVersion: 1 }]);
    expect(dto.version).toBe(1);
    expect(h.auditCalls).toEqual(['v-1']); // audited AFTER commit
  });

  test('a second generation APPENDS version 2 — version 1 is never mutated', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1, auditStatus: 'held', approvalStatus: 'pending' }],
    });
    await h.service.upsertGeneratedVersion(ctx, generatedInput);
    const version = h.created.find((c) => c.table === 'version')!;
    expect(version.version).toBe(2);
    // No update ever targets v-1's subject/body.
    for (const u of h.versionUpdates) {
      expect(u).not.toHaveProperty('subject');
      expect(u).not.toHaveProperty('body');
      expect(u).not.toHaveProperty('contentHash');
    }
  });

  test('another user cannot create a version on this record (404, no existence leak)', async () => {
    const h = makeHarness({ recordOwner: 'someone-else' });
    await expect(h.service.upsertGeneratedVersion(ctx, generatedInput)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('an enforce-mode audit failure leaves the version UNAVAILABLE, not deleted', async () => {
    const { OutreachAuditUnavailableError } = await import('./outreach-draft-audit.service.js');
    const h = makeHarness({
      auditImpl: async (id) => {
        throw new OutreachAuditUnavailableError(id, 'ledger write failed');
      },
    });
    // Does NOT throw: one broken recipient must not fail a whole batch.
    const dto = await h.service.upsertGeneratedVersion(ctx, generatedInput);
    // The version still exists...
    expect(h.created.some((c) => c.table === 'version')).toBe(true);
    // ...and is not sendable (the audit service persisted 'pending'/'unavailable').
    expect(dto.sendable).toBe(false);
  });
});

describe('createEditedVersion', () => {
  test('a one-character edit of a HELD version creates v2 that is blocked on its OWN audit', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [
        { id: 'v-1', version: 1, auditStatus: 'held', approvalStatus: 'pending', body: 'Body' },
      ],
      auditImpl: async (versionId) => ({
        versionId,
        auditStatus: 'held',
        approvalStatus: 'pending',
        auditMode: 'enforce',
        auditDecision: 'hold',
        findingCount: 1,
        reviewRequestId: 'rr-2',
      }),
    });
    const dto = await h.service.createEditedVersion(ctx, 'art-1', {
      baseVersionId: 'v-1',
      subject: 'Hello',
      body: 'Body.',
      editKind: 'manual',
    });
    const version = h.created.find((c) => c.table === 'version')!;
    expect(version.version).toBe(2);
    expect(version.sourceVersionId).toBe('v-1');
    expect(version.generationStatus).toBe('manually_authored');
    // Editing did NOT inherit v1's approval state, and the new row is blocked.
    expect(version.approvalStatus).toBe('not_required');
    expect(dto.sendable).toBe(false);
  });

  test('the edited version inherits provider/prompt/ledger provenance from its base', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1 }],
    });
    await h.service.createEditedVersion(ctx, 'art-1', {
      baseVersionId: 'v-1',
      subject: 'S2',
      body: 'B2',
      editKind: 'improve',
    });
    const version = h.created.find((c) => c.table === 'version')!;
    // Inherited so the v2-prompt send gate still applies to hand-edited text.
    expect(version.promptSpecVersion).toBe('v2.1');
    expect(version.provider).toBe('anthropic');
  });

  test('a STALE base version is refused with 409 carrying the current id but NOT the body', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 3,
      versions: [
        { id: 'v-2', version: 2 },
        { id: 'v-3', version: 3, subject: 'WINNER', body: 'winning text' },
      ],
    });
    let caught: unknown;
    try {
      await h.service.createEditedVersion(ctx, 'art-1', {
        baseVersionId: 'v-2', // stale: current is v-3
        subject: 'mine',
        body: 'mine',
        editKind: 'manual',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const body = (caught as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.error).toBe('OUTREACH_DRAFT_VERSION_STALE');
    expect(body.currentVersionId).toBe('v-3');
    // The winner's content must not leak through the conflict response.
    expect(JSON.stringify(body)).not.toContain('winning text');
    expect(JSON.stringify(body)).not.toContain('WINNER');
  });

  test('an empty edit is rejected before any write', async () => {
    const h = makeHarness({ artifactCurrentVersion: 1, versions: [{ id: 'v-1', version: 1 }] });
    await expect(
      h.service.createEditedVersion(ctx, 'art-1', {
        baseVersionId: 'v-1',
        subject: '   ',
        body: '',
        editKind: 'manual',
      }),
    ).rejects.toThrow();
    expect(h.created).toHaveLength(0);
  });
});

describe('upsertGeneratedVersionOrCandidate (Phase 2 §3.f2)', () => {
  test('a brand-new slot (no prior version) takes the normal path — advances current like upsertGeneratedVersion', async () => {
    const h = makeHarness({ artifactCurrentVersion: 0 });
    const dto = await h.service.upsertGeneratedVersionOrCandidate(ctx, generatedInput);
    expect(dto.mode).toBe('current');
    expect(dto.version).toBe(1);
    expect(h.artifactUpdates).toEqual([{ currentVersion: 1 }]);
  });

  test('regenerating over a GENERATED (not manually authored) current version still advances current', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1, generationStatus: 'generated' }],
    });
    const dto = await h.service.upsertGeneratedVersionOrCandidate(ctx, generatedInput);
    expect(dto.mode).toBe('current');
    expect(dto.version).toBe(2);
    expect(h.artifactUpdates).toEqual([{ currentVersion: 2 }]);
  });

  test('regenerating over a MANUALLY AUTHORED current version persists a candidate WITHOUT advancing current', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [
        { id: 'v-1', version: 1, generationStatus: 'manually_authored', subject: 'my edit' },
      ],
    });
    const dto = await h.service.upsertGeneratedVersionOrCandidate(ctx, generatedInput);
    expect(dto.mode).toBe('candidate');
    if (dto.mode === 'candidate') expect(dto.baseVersion).toBe(1);
    expect(dto.version).toBe(2); // numbered, but not current
    // The artifact's currentVersion was NEVER touched — v-1 (the user's edit)
    // is still what the wizard shows.
    expect(h.artifactUpdates).toEqual([]);
  });

  test('a second candidate offered before the first is accepted gets version 3, not a collision at 2', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1, generationStatus: 'manually_authored' }],
    });
    const first = await h.service.upsertGeneratedVersionOrCandidate(ctx, generatedInput);
    const second = await h.service.upsertGeneratedVersionOrCandidate(ctx, generatedInput);
    expect(first.mode).toBe('candidate');
    expect(second.mode).toBe('candidate');
    expect(first.version).toBe(2);
    expect(second.version).toBe(3);
    expect(h.artifactUpdates).toEqual([]); // current never moved for either
  });
});

describe('acceptCandidateVersion (Phase 2 §3.f2)', () => {
  test('advances current to the candidate when the base version still matches', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [
        { id: 'v-1', version: 1, generationStatus: 'manually_authored' },
        { id: 'v-2', version: 2, generationStatus: 'generated' },
      ],
    });
    const artifact = await h.service.acceptCandidateVersion(ctx, 'art-1', 'v-2', 1);
    expect(h.artifactUpdates).toEqual([{ currentVersion: 2 }]);
    expect(artifact.currentVersion).toBe(2);
  });

  test('409s when the artifact moved since the candidate was offered — never silently overwrites', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 2, // someone else already advanced it
      versions: [
        { id: 'v-1', version: 1 },
        { id: 'v-2', version: 2 },
      ],
    });
    let caught: unknown;
    try {
      await h.service.acceptCandidateVersion(ctx, 'art-1', 'v-2', 1); // stale expectedBaseVersion
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const body = (caught as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.error).toBe('OUTREACH_DRAFT_VERSION_STALE');
    expect(h.artifactUpdates).toEqual([]);
  });

  test('409s when the target version is already current or older — nothing to accept', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 2,
      versions: [
        { id: 'v-1', version: 1 },
        { id: 'v-2', version: 2 },
      ],
    });
    let caught: unknown;
    try {
      await h.service.acceptCandidateVersion(ctx, 'art-1', 'v-1', 2); // v-1 is OLDER than current
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const body = (caught as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.error).toBe('OUTREACH_DRAFT_NOT_A_CANDIDATE');
  });

  test('a nonexistent candidate version is a 404', async () => {
    const h = makeHarness({ artifactCurrentVersion: 1, versions: [{ id: 'v-1', version: 1 }] });
    await expect(
      h.service.acceptCandidateVersion(ctx, 'art-1', 'v-does-not-exist', 1),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.artifactUpdates).toEqual([]);
  });
});

describe('decideWithinTx (exact-version approval)', () => {
  const review = {
    id: 'rr-1',
    subjectId: 'v-1',
    subjectType: OUTREACH_DRAFT_VERSION_SUBJECT_TYPE,
    surface: 'outreach',
  };

  test('approval rewrites BOTH lifecycle fields on the reviewed row and nothing else', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1, auditStatus: 'held', approvalStatus: 'pending' }],
      review,
    });
    await h.service.approveVersion(ctx, 'v-1', 'rr-1');
    expect(h.versionUpdates).toEqual([{ approvalStatus: 'approved', auditStatus: 'passed' }]);
  });

  test('rejection keeps the audit hold (the finding was never resolved)', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1, auditStatus: 'held', approvalStatus: 'pending' }],
      review,
    });
    await h.service.rejectVersion(ctx, 'v-1', 'rr-1');
    expect(h.versionUpdates).toEqual([{ approvalStatus: 'rejected' }]);
  });

  test('a review governing a DIFFERENT version cannot release this one', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 2,
      versions: [{ id: 'v-2', version: 2, auditStatus: 'held', approvalStatus: 'pending' }],
      review: { ...review, subjectId: 'v-1' }, // review is for v-1, we approve v-2
    });
    await expect(h.service.approveVersion(ctx, 'v-2', 'rr-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.versionUpdates).toHaveLength(0);
  });

  test('a LEGACY content-keyed review cannot release a version', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1, auditStatus: 'held', approvalStatus: 'pending' }],
      review: { ...review, subjectType: 'outreach-draft' },
    });
    await expect(h.service.approveVersion(ctx, 'v-1', 'rr-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.versionUpdates).toHaveLength(0);
  });

  test('a missing review is a 404, not a silent release', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1 }],
      review: null,
    });
    await expect(h.service.approveVersion(ctx, 'v-1', 'rr-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.versionUpdates).toHaveLength(0);
  });
});

describe('getVersion ownership', () => {
  test("another user's version is a 404 (existence not disclosed)", async () => {
    const h = makeHarness({ artifactCurrentVersion: 1, versions: [{ id: 'v-1', version: 1 }] });
    const foreign: TenantContext = { ...ctx, userId: 'intruder' } as TenantContext;
    await expect(h.service.getVersion(foreign, 'v-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('the owner gets the version with a server-computed `sendable`', async () => {
    const h = makeHarness({
      artifactCurrentVersion: 1,
      versions: [{ id: 'v-1', version: 1, auditStatus: 'passed', approvalStatus: 'not_required' }],
    });
    const dto = await h.service.getVersion(ctx, 'v-1');
    expect(dto.sendable).toBe(true);
    expect(dto.id).toBe('v-1');
  });
});

// Keep jest's unused-import lint quiet while documenting intent.
void jest;
