/**
 * Engagement Phase 0 (plan §3.b1) — immutable, versioned outreach drafts.
 *
 * The trust boundary this service creates: an externally sendable draft is a ROW,
 * not a payload. Generation, edits, "Improve" and "Revert" all APPEND a version;
 * nothing ever mutates the subject/body of an existing one. The send path then
 * accepts version ids only, so a caller cannot hand the provider text that no
 * audit ever judged.
 *
 * Concurrency: the artifact row is the lock. Version numbering takes
 * `SELECT ... FOR UPDATE` on it inside the same transaction that inserts the
 * version, and `(artifact_id, version)` is UNIQUE as a second line of defence,
 * so two tabs generating/editing the same slot cannot mint the same version.
 *
 * Ownership: outreach drafts are OWNER-PRIVATE in Phase 0. Tenant RLS is not
 * sufficient on its own — every read and write here also requires the parent
 * OutreachRecord to have been created by the calling user. A collaborative
 * campaign model is explicitly out of scope (plan §6.6).
 *
 * No LLM, auditor, provider or Reviews call happens inside the version-creating
 * transaction: those are slow and failure-prone, and holding a row lock across
 * them is how you get the pool starvation this codebase has already been bitten
 * by. The audit runs immediately AFTER commit, and its failure marks the exact
 * version `unavailable` — never deletes it.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { LedgerEntry } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  OutreachAuditUnavailableError,
  OutreachDraftAuditService,
  type DeterministicVerifierCheck,
} from './outreach-draft-audit.service.js';
import {
  isDraftVersionSendable,
  OUTREACH_DRAFT_VERSION_SUBJECT_TYPE,
  type DraftApprovalStatus,
  type DraftAuditStatus,
  type DraftGenerationStatus,
} from './outreach-draft.types.js';

export type DraftEditKind = 'manual' | 'improve' | 'revert';

export interface UpsertGeneratedVersionInput {
  outreachRecordId: string;
  /** The wizard's GenerationTargetKey — the stable identity of this draft slot. */
  generationKey: string;
  recipientKey: string;
  audienceKind: 'individual' | 'group';
  recipientSnapshot: Record<string, unknown>;
  subject: string;
  body: string;
  provider?: string | null;
  model?: string | null;
  promptSpecVersion?: string | null;
  contextPacketId?: string | null;
  /**
   * The EXACT structured ledger entries the auditor must judge this text
   * against — passed through from generation, never re-derived from prose.
   */
  auditLedger?: LedgerEntry[];
  /**
   * Phase 1 §3.i2 — findings from the deterministic government-affairs verifier,
   * computed on THIS exact text by the generation gateway. Merged into the
   * version's auditFindings alongside the Meri auditor's (distinguished by
   * `source`); a blocking one holds the version regardless of MERI_AUDITOR_MODE.
   */
  verifierFindings?: DeterministicVerifierCheck[];
}

export interface CreateEditedVersionInput {
  baseVersionId: string;
  subject: string;
  body: string;
  editKind: DraftEditKind;
}

/** One check name + severity. Never spans, evidence or raw auditor internals. */
export interface DraftAuditCheckDto {
  check: string;
  severity: string;
}

export interface OutreachDraftVersionDto {
  id: string;
  artifactId: string;
  outreachRecordId: string;
  version: number;
  sourceVersionId: string | null;
  generationKey: string;
  recipientKey: string;
  audienceKind: string;
  subject: string;
  body: string;
  contentHash: string;
  generationStatus: DraftGenerationStatus;
  auditStatus: DraftAuditStatus;
  approvalStatus: DraftApprovalStatus;
  auditDecision: string | null;
  auditChecks: DraftAuditCheckDto[];
  reviewRequestId: string | null;
  provider: string | null;
  model: string | null;
  promptSpecVersion: string | null;
  /** Derived from the lifecycle fields — the wizard must never compute this. */
  sendable: boolean;
  createdAt: string;
  contextNote?: string;
}

/** Version metadata only (no text) — enough to render a history strip. */
export interface DraftVersionSummaryDto {
  id: string;
  version: number;
  generationStatus: DraftGenerationStatus;
  auditStatus: DraftAuditStatus;
  approvalStatus: DraftApprovalStatus;
  createdAt: string;
}

export interface OutreachDraftArtifactDto {
  id: string;
  outreachRecordId: string;
  generationKey: string;
  recipientKey: string;
  audienceKind: string;
  currentVersion: number;
  current: OutreachDraftVersionDto | null;
  history: DraftVersionSummaryDto[];
}

/** Columns every DTO mapping needs. Kept in one place so reads cannot drift. */
const VERSION_SELECT = {
  id: true,
  tenantId: true,
  artifactId: true,
  version: true,
  sourceVersionId: true,
  subject: true,
  body: true,
  contentHash: true,
  generationStatus: true,
  auditStatus: true,
  approvalStatus: true,
  auditMode: true,
  auditDecision: true,
  auditFindings: true,
  auditLedger: true,
  reviewRequestId: true,
  contextPacketId: true,
  provider: true,
  model: true,
  promptSpecVersion: true,
  createdAt: true,
  artifact: {
    select: {
      id: true,
      outreachRecordId: true,
      generationKey: true,
      recipientKey: true,
      audienceKind: true,
      currentVersion: true,
      createdByUserId: true,
    },
  },
} as const;

type VersionRow = Prisma.OutreachDraftVersionGetPayload<{ select: typeof VERSION_SELECT }>;

@Injectable()
export class OutreachDraftService {
  private readonly logger = new Logger(OutreachDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OutreachDraftAuditService,
  ) {}

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Persist a freshly generated draft as a NEW immutable version of its slot,
   * then audit that exact version.
   *
   * The version lands with `audit_status='pending'` — i.e. NOT sendable — and
   * only the post-commit audit can move it to passed/warning/held/unavailable.
   * A crash between the two leaves a pending (non-sendable) version, which is
   * the safe direction.
   */
  async upsertGeneratedVersion(
    ctx: TenantContext,
    input: UpsertGeneratedVersionInput,
  ): Promise<OutreachDraftVersionDto> {
    const created = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertRecordOwned(tx, ctx, input.outreachRecordId);
      const artifactId = await this.findOrCreateArtifactId(tx, ctx, input);
      const nextVersion = await this.lockAndBumpArtifact(tx, ctx, artifactId);
      const row = await tx.outreachDraftVersion.create({
        data: {
          tenantId: ctx.tenantId,
          artifactId,
          version: nextVersion,
          subject: input.subject,
          body: input.body,
          contentHash: contentHashOf(input.subject, input.body),
          generationStatus: 'generated',
          // Pending until the post-commit audit rules. isDraftVersionSendable()
          // blocks 'pending', so a version is never sendable before its verdict.
          auditStatus: 'pending',
          approvalStatus: 'not_required',
          auditLedger: (input.auditLedger ?? []) as unknown as Prisma.InputJsonValue,
          provider: input.provider ?? null,
          model: input.model ? input.model.slice(0, 160) : null,
          promptSpecVersion: input.promptSpecVersion ?? null,
          contextPacketId: input.contextPacketId ?? null,
          createdByUserId: ctx.userId,
        },
        select: VERSION_SELECT,
      });
      return row;
    });

    return this.auditAndReload(ctx, created, input.verifierFindings);
  }

  /**
   * Append an edited version (manual keystrokes, an AI "Improve", or a
   * "Revert"). The prior version is left exactly as it was — including any
   * approval it earned — and the new text is audited on its own.
   *
   * A stale `baseVersionId` is a 409 carrying the CURRENT version id but never
   * the current body: the loser of an edit race must not learn the winner's
   * content from an error response.
   */
  async createEditedVersion(
    ctx: TenantContext,
    artifactId: string,
    input: CreateEditedVersionInput,
  ): Promise<OutreachDraftVersionDto> {
    if (!input.subject.trim() && !input.body.trim()) {
      throw new BadRequestException('A draft version needs a subject or a body.');
    }

    const created = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const artifact = await tx.outreachDraftArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId },
        select: {
          id: true,
          outreachRecordId: true,
          currentVersion: true,
          createdByUserId: true,
        },
      });
      if (!artifact) throw new NotFoundException('Draft not found');
      await this.assertRecordOwned(tx, ctx, artifact.outreachRecordId);

      // Lock BEFORE validating the base version, so a concurrent writer cannot
      // slip a version in between the staleness check and the insert.
      const nextVersion = await this.lockAndBumpArtifact(tx, ctx, artifactId);
      const base = await tx.outreachDraftVersion.findFirst({
        where: { id: input.baseVersionId, tenantId: ctx.tenantId, artifactId },
        select: {
          id: true,
          version: true,
          auditLedger: true,
          contextPacketId: true,
          provider: true,
          model: true,
          promptSpecVersion: true,
        },
      });
      if (!base) {
        throw new NotFoundException('The draft version you edited no longer exists.');
      }
      // nextVersion is currentVersion + 1, so the base must be the version that
      // WAS current. Anything else means someone else already appended.
      if (base.version !== nextVersion - 1) {
        const current = await tx.outreachDraftVersion.findFirst({
          where: { tenantId: ctx.tenantId, artifactId, version: nextVersion - 1 },
          select: { id: true, version: true },
        });
        throw new ConflictException({
          statusCode: 409,
          error: 'OUTREACH_DRAFT_VERSION_STALE',
          message:
            'A newer version of this draft exists. Load the latest version before editing again.',
          currentVersionId: current?.id ?? null,
          currentVersion: current?.version ?? null,
        });
      }

      return tx.outreachDraftVersion.create({
        data: {
          tenantId: ctx.tenantId,
          artifactId,
          version: nextVersion,
          sourceVersionId: base.id,
          subject: input.subject,
          body: input.body,
          contentHash: contentHashOf(input.subject, input.body),
          generationStatus: 'manually_authored',
          auditStatus: 'pending',
          approvalStatus: 'not_required',
          // Carry the base version's grounding evidence + provenance forward:
          // the edited text still makes claims about the SAME source material,
          // so it must be judged against the same ledger. Provider/prompt
          // metadata is inherited so the v2-required send gate still applies to
          // a hand-edited draft (plan §3.d1 step 5).
          auditLedger: (base.auditLedger ?? []) as Prisma.InputJsonValue,
          contextPacketId: base.contextPacketId,
          provider: base.provider,
          model: base.model,
          promptSpecVersion: base.promptSpecVersion,
          createdByUserId: ctx.userId,
        },
        select: VERSION_SELECT,
      });
    });

    return this.auditAndReload(ctx, created);
  }

  /**
   * Phase 2 §3.f2 — the regeneration entry point. Persists as a normal
   * version (advances current) UNLESS the artifact already has a current
   * version AND it was manually authored, in which case it persists as a
   * CANDIDATE instead — a version numbered above `currentVersion` that does
   * NOT advance it — so a hand edit is never silently overwritten by a
   * regenerate. A brand-new slot (no prior version) always takes the normal
   * path; there is nothing to protect yet.
   *
   * The guard check and the version insert share ONE transaction with the
   * artifact row locked throughout (same discipline as createEditedVersion's
   * staleness check above) — otherwise a manual edit landing between "check"
   * and "write" could still get silently overwritten.
   *
   * Any version whose number exceeds `currentVersion` IS, by definition, an
   * unaccepted candidate; there is no separate "candidate" flag to keep
   * consistent, and "reject" is simply never calling acceptCandidateVersion().
   */
  async upsertGeneratedVersionOrCandidate(
    ctx: TenantContext,
    input: UpsertGeneratedVersionInput,
  ): Promise<
    | (OutreachDraftVersionDto & { mode: 'current' })
    | (OutreachDraftVersionDto & { mode: 'candidate'; baseVersion: number })
  > {
    const created = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertRecordOwned(tx, ctx, input.outreachRecordId);
      const artifactId = await this.findOrCreateArtifactId(tx, ctx, input);

      const locked = await tx.$queryRaw<Array<{ current_version: number }>>`
        SELECT current_version
        FROM outreach_draft_artifacts
        WHERE id = ${artifactId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Draft not found');
      const baseVersion = Number(locked[0]!.current_version);

      const current =
        baseVersion === 0
          ? null
          : await tx.outreachDraftVersion.findFirst({
              where: { tenantId: ctx.tenantId, artifactId, version: baseVersion },
              select: { generationStatus: true },
            });
      const guardEdited = current?.generationStatus === 'manually_authored';

      let nextVersion: number;
      if (guardEdited) {
        // Candidate: numbered from MAX(existing version), not baseVersion + 1,
        // so a second candidate offered before the first is accepted/discarded
        // still gets a fresh, non-colliding number. currentVersion is untouched.
        const maxVersion = await tx.outreachDraftVersion.aggregate({
          where: { tenantId: ctx.tenantId, artifactId },
          _max: { version: true },
        });
        nextVersion = Math.max(maxVersion._max.version ?? 0, baseVersion) + 1;
      } else {
        nextVersion = baseVersion + 1;
        await tx.outreachDraftArtifact.update({
          where: { id: artifactId },
          data: { currentVersion: nextVersion },
        });
      }

      const row = await tx.outreachDraftVersion.create({
        data: {
          tenantId: ctx.tenantId,
          artifactId,
          version: nextVersion,
          subject: input.subject,
          body: input.body,
          contentHash: contentHashOf(input.subject, input.body),
          generationStatus: 'generated',
          auditStatus: 'pending',
          approvalStatus: 'not_required',
          auditLedger: (input.auditLedger ?? []) as unknown as Prisma.InputJsonValue,
          provider: input.provider ?? null,
          model: input.model ? input.model.slice(0, 160) : null,
          promptSpecVersion: input.promptSpecVersion ?? null,
          contextPacketId: input.contextPacketId ?? null,
          createdByUserId: ctx.userId,
        },
        select: VERSION_SELECT,
      });
      return { row, guardEdited, baseVersion };
    });

    const audited = await this.auditAndReload(ctx, created.row, input.verifierFindings);
    return created.guardEdited
      ? { ...audited, mode: 'candidate' as const, baseVersion: created.baseVersion }
      : { ...audited, mode: 'current' as const };
  }

  /**
   * Advance the artifact's current version to an existing, still-valid
   * candidate. 409s if the artifact moved since the candidate was offered
   * (someone accepted a different candidate, or authored a new edited
   * version) — the caller must re-fetch and re-decide, never silently
   * overwrite whatever is current now.
   */
  async acceptCandidateVersion(
    ctx: TenantContext,
    artifactId: string,
    candidateVersionId: string,
    expectedBaseVersion: number,
  ): Promise<OutreachDraftArtifactDto> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const artifact = await tx.outreachDraftArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId },
        select: { id: true, outreachRecordId: true },
      });
      if (!artifact) throw new NotFoundException('Draft not found');
      await this.assertRecordOwned(tx, ctx, artifact.outreachRecordId);

      const locked = await tx.$queryRaw<Array<{ current_version: number }>>`
        SELECT current_version
        FROM outreach_draft_artifacts
        WHERE id = ${artifactId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Draft not found');
      const currentVersion = Number(locked[0]!.current_version);
      if (currentVersion !== expectedBaseVersion) {
        throw new ConflictException({
          statusCode: 409,
          error: 'OUTREACH_DRAFT_VERSION_STALE',
          message: 'This draft changed since the candidate was generated. Reload before accepting.',
          currentVersion,
        });
      }
      const candidate = await tx.outreachDraftVersion.findFirst({
        where: { id: candidateVersionId, tenantId: ctx.tenantId, artifactId },
        select: { id: true, version: true },
      });
      if (!candidate) throw new NotFoundException('Candidate version not found');
      if (candidate.version <= currentVersion) {
        throw new ConflictException({
          statusCode: 409,
          error: 'OUTREACH_DRAFT_NOT_A_CANDIDATE',
          message: 'That version is already current, or older — there is nothing to accept.',
        });
      }
      await tx.outreachDraftArtifact.update({
        where: { id: artifactId },
        data: { currentVersion: candidate.version },
      });
    });
    const artifact = await this.loadArtifact(ctx, artifactId);
    if (!artifact) throw new NotFoundException('Draft not found');
    return artifact;
  }

  /**
   * Create the artifact row WITHOUT a version. Used when generation failed: the
   * slot still needs a stable target so the user can author a version by hand,
   * but there is no generated text to persist and nothing to audit.
   */
  async ensureArtifact(
    ctx: TenantContext,
    input: UpsertGeneratedVersionInput,
  ): Promise<OutreachDraftArtifactDto> {
    const artifactId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertRecordOwned(tx, ctx, input.outreachRecordId);
      return this.findOrCreateArtifactId(tx, ctx, input);
    });
    const artifact = await this.loadArtifact(ctx, artifactId);
    if (!artifact) throw new NotFoundException('Draft not found');
    return artifact;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** One version, owner-scoped. */
  async getVersion(ctx: TenantContext, versionId: string): Promise<OutreachDraftVersionDto> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftVersion.findFirst({
        where: { id: versionId, tenantId: ctx.tenantId },
        select: VERSION_SELECT,
      }),
    );
    // Same 404 for "does not exist" and "belongs to another user" — existence is
    // not leaked across users (plan edge case 8).
    if (!row || row.artifact.createdByUserId !== ctx.userId) {
      throw new NotFoundException('Draft version not found');
    }
    return toVersionDto(row);
  }

  /**
   * One version for a REVIEWER. Tenant-scoped but deliberately NOT owner-scoped:
   * a reviewer is by definition not the author. The caller (ReviewsService) is
   * responsible for the admin/assignee/requester access check — this method does
   * not authorize on its own, which is why it is named explicitly.
   */
  async getVersionForReviewerUnchecked(
    tenantId: string,
    versionId: string,
  ): Promise<OutreachDraftVersionDto | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.outreachDraftVersion.findFirst({
        where: { id: versionId, tenantId },
        select: VERSION_SELECT,
      }),
    );
    return row ? toVersionDto(row) : null;
  }

  /** Every draft slot for one outreach record, owner-scoped. */
  async listForOutreach(
    ctx: TenantContext,
    outreachRecordId: string,
  ): Promise<OutreachDraftArtifactDto[]> {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      this.assertRecordOwned(tx, ctx, outreachRecordId),
    );
    const artifacts = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftArtifact.findMany({
        where: { tenantId: ctx.tenantId, outreachRecordId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          outreachRecordId: true,
          generationKey: true,
          recipientKey: true,
          audienceKind: true,
          currentVersion: true,
          versions: {
            orderBy: { version: 'desc' },
            select: VERSION_SELECT,
          },
        },
      }),
    );
    return artifacts.map((a) => {
      const current = a.versions.find((v) => v.version === a.currentVersion) ?? a.versions[0];
      return {
        id: a.id,
        outreachRecordId: a.outreachRecordId,
        generationKey: a.generationKey,
        recipientKey: a.recipientKey,
        audienceKind: a.audienceKind,
        currentVersion: a.currentVersion,
        current: current ? toVersionDto(current) : null,
        history: a.versions.map(toVersionSummary),
      };
    });
  }

  // ── Review decisions ──────────────────────────────────────────────────────

  /**
   * Release the EXACT reviewed version.
   *
   * Approval rewrites both lifecycle fields on that one immutable row
   * (`approved` + `passed`) and touches nothing else: subject, body and
   * contentHash are untouched, so what a reviewer read is byte-identical to what
   * can now be sent. A newer version of the same slot is unaffected and remains
   * blocked by its own verdict (plan edge case 6).
   */
  async approveVersion(
    ctx: TenantContext,
    versionId: string,
    reviewRequestId: string,
  ): Promise<OutreachDraftVersionDto> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      this.decideWithinTx(tx, ctx.tenantId, versionId, reviewRequestId, 'approved'),
    );
    return toVersionDto(row);
  }

  /** Refuse the exact reviewed version. A new version is required to proceed. */
  async rejectVersion(
    ctx: TenantContext,
    versionId: string,
    reviewRequestId: string,
  ): Promise<OutreachDraftVersionDto> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      this.decideWithinTx(tx, ctx.tenantId, versionId, reviewRequestId, 'rejected'),
    );
    return toVersionDto(row);
  }

  /**
   * Transaction-aware decision for ReviewsService (plan §3.f1). Reviews owns the
   * single transaction so the version state and the ReviewRequest decision
   * commit together — nesting two Prisma transactions would not be atomic.
   */
  async decideWithinTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    versionId: string,
    reviewRequestId: string,
    decision: 'approved' | 'rejected',
  ): Promise<VersionRow> {
    const version = await tx.outreachDraftVersion.findFirst({
      where: { id: versionId, tenantId },
      select: { id: true, auditStatus: true, approvalStatus: true },
    });
    if (!version) throw new NotFoundException('Draft version not found');

    // The review must be FOR this exact version. Without this, approving any
    // outreach review could release an unrelated draft.
    const review = await tx.reviewRequest.findFirst({
      where: { id: reviewRequestId, tenantId },
      select: { id: true, subjectId: true, subjectType: true, surface: true },
    });
    if (!review) throw new NotFoundException('Review not found');
    if (
      review.surface !== 'outreach' ||
      review.subjectType !== OUTREACH_DRAFT_VERSION_SUBJECT_TYPE ||
      review.subjectId !== versionId
    ) {
      throw new ForbiddenException('This review does not govern that draft version.');
    }

    await tx.outreachDraftVersion.updateMany({
      where: { id: versionId, tenantId },
      data:
        decision === 'approved'
          ? // Both fields move together: 'held' + 'approved' is deliberately NOT
            // sendable (see isDraftVersionSendable), so releasing a held version
            // REQUIRES clearing the audit hold on this same row.
            { approvalStatus: 'approved', auditStatus: 'passed' }
          : // Rejected keeps the audit hold: the finding was never resolved.
            { approvalStatus: 'rejected' },
    });

    const updated = await tx.outreachDraftVersion.findFirst({
      where: { id: versionId, tenantId },
      select: VERSION_SELECT,
    });
    if (!updated) throw new NotFoundException('Draft version not found');
    return updated;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Run the post-commit audit, then re-read the version so the returned DTO
   * carries the persisted verdict rather than an optimistic guess.
   *
   * An enforce-mode control failure has ALREADY written `unavailable` before it
   * threw; we swallow that specific error so one held/broken recipient does not
   * fail a whole batch, and the caller still sees a non-sendable version.
   */
  private async auditAndReload(
    ctx: TenantContext,
    created: VersionRow,
    verifierFindings?: DeterministicVerifierCheck[],
  ): Promise<OutreachDraftVersionDto> {
    let contextNote: string | undefined;
    try {
      const outcome = await this.audit.runForVersion(ctx, created.id, {
        ...(verifierFindings?.length ? { verifierFindings } : {}),
      });
      contextNote = outcome.contextNote;
    } catch (err) {
      if (err instanceof OutreachAuditUnavailableError) {
        this.logger.warn(
          `outreach draft version ${created.id} is NOT sendable — verification unavailable.`,
        );
      } else {
        // Any other post-commit failure must also fail closed on this exact
        // version. The version is never deleted: it is the record of what was
        // generated, it just cannot be sent.
        this.logger.error(
          `unexpected audit failure for version ${created.id}: ${(err as Error).message}`,
        );
        await this.forceUnavailable(ctx, created.id);
      }
    }

    const fresh = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftVersion.findFirst({
        where: { id: created.id, tenantId: ctx.tenantId },
        select: VERSION_SELECT,
      }),
    );
    const dto = toVersionDto(fresh ?? created);
    return contextNote ? { ...dto, contextNote } : dto;
  }

  private async forceUnavailable(ctx: TenantContext, versionId: string): Promise<void> {
    try {
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.outreachDraftVersion.updateMany({
          where: { id: versionId, tenantId: ctx.tenantId },
          data: {
            auditStatus: 'unavailable',
            approvalStatus: 'pending',
            auditDecision: 'audit_unavailable',
          },
        }),
      );
    } catch (e) {
      // The version keeps its creation-time 'pending' audit status, which is
      // already non-sendable — so this failure cannot open the send gate.
      this.logger.error(
        `could not mark version ${versionId} unavailable: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Phase 0 ownership rule (plan §3.h2): a draft record is private to its
   * author. Tenant RLS alone would make every colleague's campaign editable.
   */
  private async assertRecordOwned(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    outreachRecordId: string,
  ): Promise<void> {
    const record = await tx.outreachRecord.findFirst({
      where: { id: outreachRecordId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, createdByUserId: true },
    });
    // Identical 404 for missing and foreign records — no existence leak.
    if (!record || record.createdByUserId !== ctx.userId) {
      throw new NotFoundException('Outreach draft record not found');
    }
  }

  private async findOrCreateArtifactId(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: UpsertGeneratedVersionInput,
  ): Promise<string> {
    const existing = await tx.outreachDraftArtifact.findFirst({
      where: {
        tenantId: ctx.tenantId,
        outreachRecordId: input.outreachRecordId,
        generationKey: input.generationKey,
      },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await tx.outreachDraftArtifact.create({
      data: {
        tenantId: ctx.tenantId,
        outreachRecordId: input.outreachRecordId,
        generationKey: input.generationKey.slice(0, 512),
        recipientKey: input.recipientKey.slice(0, 256),
        audienceKind: input.audienceKind,
        recipientSnapshot: input.recipientSnapshot as Prisma.InputJsonValue,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Take the artifact row lock and reserve the next version number in the SAME
   * transaction that will insert the version.
   *
   * Parameterized `$queryRaw` (tagged template), never `$queryRawUnsafe`: the
   * artifact id and tenant id arrive as bind parameters.
   */
  private async lockAndBumpArtifact(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    artifactId: string,
  ): Promise<number> {
    const locked = await tx.$queryRaw<Array<{ current_version: number }>>`
      SELECT current_version
      FROM outreach_draft_artifacts
      WHERE id = ${artifactId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
      FOR UPDATE
    `;
    if (!locked.length) throw new NotFoundException('Draft not found');
    const nextVersion = Number(locked[0]!.current_version) + 1;
    await tx.outreachDraftArtifact.update({
      where: { id: artifactId },
      data: { currentVersion: nextVersion },
    });
    return nextVersion;
  }

  private async loadArtifact(
    ctx: TenantContext,
    artifactId: string,
  ): Promise<OutreachDraftArtifactDto | null> {
    const a = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId },
        select: {
          id: true,
          outreachRecordId: true,
          generationKey: true,
          recipientKey: true,
          audienceKind: true,
          currentVersion: true,
          versions: { orderBy: { version: 'desc' }, select: VERSION_SELECT },
        },
      }),
    );
    if (!a) return null;
    const current = a.versions.find((v) => v.version === a.currentVersion) ?? a.versions[0];
    return {
      id: a.id,
      outreachRecordId: a.outreachRecordId,
      generationKey: a.generationKey,
      recipientKey: a.recipientKey,
      audienceKind: a.audienceKind,
      currentVersion: a.currentVersion,
      current: current ? toVersionDto(current) : null,
      history: a.versions.map(toVersionSummary),
    };
  }
}

// ── pure helpers (exported for unit tests) ───────────────────────────────────

/** Stable content identity of a version: sha256 over subject + body. */
export function contentHashOf(subject: string, body: string): string {
  return `sha256:${createHash('sha256').update(`${subject}\n${body}`, 'utf8').digest('hex')}`;
}

function readChecks(raw: unknown): DraftAuditCheckDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({ check: String(f.check ?? '?'), severity: String(f.severity ?? '?') }));
}

export function toVersionDto(row: VersionRow): OutreachDraftVersionDto {
  const auditStatus = row.auditStatus as DraftAuditStatus;
  const approvalStatus = row.approvalStatus as DraftApprovalStatus;
  return {
    id: row.id,
    artifactId: row.artifactId,
    outreachRecordId: row.artifact.outreachRecordId,
    version: row.version,
    sourceVersionId: row.sourceVersionId,
    generationKey: row.artifact.generationKey,
    recipientKey: row.artifact.recipientKey,
    audienceKind: row.artifact.audienceKind,
    subject: row.subject,
    body: row.body,
    contentHash: row.contentHash,
    generationStatus: row.generationStatus as DraftGenerationStatus,
    auditStatus,
    approvalStatus,
    auditDecision: row.auditDecision,
    auditChecks: readChecks(row.auditFindings),
    reviewRequestId: row.reviewRequestId,
    provider: row.provider,
    model: row.model,
    promptSpecVersion: row.promptSpecVersion,
    sendable: isDraftVersionSendable({ auditStatus, approvalStatus }),
    createdAt: row.createdAt.toISOString(),
  };
}

function toVersionSummary(row: VersionRow): DraftVersionSummaryDto {
  return {
    id: row.id,
    version: row.version,
    generationStatus: row.generationStatus as DraftGenerationStatus,
    auditStatus: row.auditStatus as DraftAuditStatus,
    approvalStatus: row.approvalStatus as DraftApprovalStatus,
    createdAt: row.createdAt.toISOString(),
  };
}
