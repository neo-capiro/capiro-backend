import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext, TenantRole } from '@capiro/shared';
import { governedMemoryModeEnabledForTenant } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MemoryAuthorizationService,
  type GovernedMemorySubjectRow,
} from './memory-authorization.service.js';
import type {
  PendingSettingsCandidate,
  SettingsMemoryCandidateInput,
} from './memory-candidate.service.js';
import { clientMemoryReviewEnabled } from './memory-review-switch.js';
import type { MemorySection } from './memory.types.js';

type ReviewActorContext = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;

interface ActiveTenantMemberRow {
  userId: string;
  role: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

interface PendingCandidateRow {
  id: string;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  clientId: string | null;
  createdAt: Date;
  payload: unknown;
}

export interface MemoryReviewerIdentity {
  userId: string;
  name: string;
  email: string;
  role: TenantRole;
}

export interface PendingSettingsReviewDetails extends PendingSettingsCandidate {
  scope: 'firm' | 'client';
  sourceKind: string;
  proposal: {
    title: string;
    sections: MemorySection[];
  };
  submittedBy?: MemoryReviewerIdentity;
  eligibleReviewers: MemoryReviewerIdentity[];
  reviewerRequirement: string;
  nextAction: string;
  blocked: boolean;
  canWithdraw: boolean;
  viewerCanReview: boolean;
  viewerCanApprove: boolean;
  viewerCanReject: boolean;
  auditReference: string;
}

export interface MemoryReviewSummary {
  enabled: boolean;
  counts: {
    awaitingMyReview: number;
    submittedByMe: number;
    allPending: number;
    blocked: number;
  };
  message: string | null;
}

/**
 * Server-owned readiness and read model for shared Settings memory.
 *
 * A firm/client submission is accepted only when the exact tenant has the
 * lifecycle, authorization, and review surface armed AND at least one other
 * active member can approve under the same role/grant/ethical-wall rules used
 * by the real decision route. The service also turns the opaque candidate row
 * into a plain review state for the Settings editor and review summary UI.
 */
@Injectable()
export class MemorySettingsReviewReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
  ) {}

  async assertSubmissionReady(
    ctx: ReviewActorContext,
    input: SettingsMemoryCandidateInput,
  ): Promise<{ eligibleReviewers: MemoryReviewerIdentity[] }> {
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      throw new ConflictException(
        'Shared memory review is not available for this workspace. Active memory was not ' +
          'changed. Ask an administrator to enable Memory Review before submitting.',
      );
    }

    const eligibleReviewers = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const subject = await this.syntheticSubjectInTx(tx, ctx, input);
        const members = await activeTenantMembersInTx(tx, ctx.tenantId);
        return this.eligibleReviewersInTx(tx, ctx.tenantId, subject, members);
      },
    );

    if (eligibleReviewers.length === 0) {
      const message =
        input.scope === 'firm'
          ? 'Firm memory requires approval from another active administrator. No eligible ' +
            'reviewer is available. Add or activate a second administrator before submitting.'
          : 'Client memory requires approval from another authorized reviewer. No eligible ' +
            'reviewer is available for this client. Grant review access or add another ' +
            'administrator before submitting.';
      throw new ConflictException(message);
    }

    return { eligibleReviewers };
  }

  async describePendingCandidate(
    tenantId: string,
    viewerUserId: string,
    pending: PendingSettingsCandidate,
    options: { reviewEnabled?: boolean } = {},
  ): Promise<PendingSettingsCandidate> {
    return this.prisma.withTenantUser(tenantId, viewerUserId, async (tx) => {
      const row = (await tx.memoryCandidate.findFirst({
        where: { id: pending.candidateId, tenantId, status: 'pending' },
        select: {
          id: true,
          proposedBy: true,
          sourceKind: true,
          scope: true,
          clientId: true,
          createdAt: true,
          payload: true,
        },
      })) as PendingCandidateRow | null;
      if (!row || (row.scope !== 'firm' && row.scope !== 'client')) return pending;

      const members = await activeTenantMembersInTx(tx, tenantId);
      const proposer =
        members.find((member) => member.userId === row.proposedBy) ??
        (await userIdentityInTx(tx, row.proposedBy));
      const viewerIsProposer = row.proposedBy === viewerUserId;

      if (options.reviewEnabled === false) {
        const details: PendingSettingsReviewDetails = {
          candidateId: row.id,
          status: 'pending_review',
          submittedAt: row.createdAt.toISOString(),
          scope: row.scope,
          sourceKind: row.sourceKind,
          proposal: viewerIsProposer
            ? proposalFromPayload(row.payload)
            : { title: 'Pending shared-memory proposal', sections: [] },
          ...(viewerIsProposer ? { submittedBy: proposer } : {}),
          eligibleReviewers: [],
          reviewerRequirement: 'Memory Review must be enabled for this workspace',
          nextAction:
            'Shared memory review is currently unavailable. Active memory remains unchanged; ' +
            'ask an administrator to enable Memory Review.',
          blocked: true,
          canWithdraw: false,
          viewerCanReview: false,
          viewerCanApprove: false,
          viewerCanReject: false,
          auditReference: row.id,
        };
        return details;
      }

      const subject = await this.authorization.loadCandidateInTx(tx, tenantId, row.id);
      if (!subject) return pending;
      const eligibleReviewers = await this.eligibleReviewersInTx(tx, tenantId, subject, members);
      const viewerApprove = viewerIsProposer
        ? ({ allowed: false } as const)
        : await this.authorization.evaluateInTx(
            tx,
            { tenantId, userId: viewerUserId, role: memberRole(members, viewerUserId) },
            subject,
            'approve',
            { emitDenialMetrics: false },
          );
      const viewerReject = viewerIsProposer
        ? ({ allowed: false } as const)
        : await this.authorization.evaluateInTx(
            tx,
            { tenantId, userId: viewerUserId, role: memberRole(members, viewerUserId) },
            subject,
            'review',
            { emitDenialMetrics: false },
          );
      const viewerCanApprove = viewerApprove.allowed;
      const viewerCanReject = viewerReject.allowed;
      const viewerCanReview = viewerCanApprove || viewerCanReject;
      const blocked = eligibleReviewers.length === 0;
      const canSeeProposal = viewerIsProposer || viewerCanReview;

      const details: PendingSettingsReviewDetails = {
        candidateId: row.id,
        status: 'pending_review',
        submittedAt: row.createdAt.toISOString(),
        scope: row.scope,
        sourceKind: row.sourceKind,
        proposal: canSeeProposal
          ? proposalFromPayload(row.payload)
          : { title: 'Pending shared-memory proposal', sections: [] },
        ...(canSeeProposal ? { submittedBy: proposer } : {}),
        eligibleReviewers: canSeeProposal ? eligibleReviewers : [],
        reviewerRequirement:
          row.scope === 'firm'
            ? 'Approval from another active administrator'
            : 'Approval from another authorized client-memory reviewer',
        nextAction: canSeeProposal
          ? nextActionForPendingReview({
              blocked,
              viewerIsProposer,
              viewerCanApprove,
              viewerCanReject,
              reviewers: eligibleReviewers,
            })
          : 'An authorized reviewer is considering a proposed change. The active memory ' +
            'remains in use until a decision is recorded.',
        blocked: canSeeProposal ? blocked : false,
        canWithdraw: viewerIsProposer,
        viewerCanReview,
        viewerCanApprove,
        viewerCanReject,
        auditReference: row.id,
      };
      return details;
    });
  }

  async summary(ctx: ReviewActorContext): Promise<MemoryReviewSummary> {
    if (!settingsMemoryReviewEnabledForTenant(ctx.tenantId)) {
      return {
        enabled: false,
        counts: emptySummaryCounts(),
        message:
          'Shared memory submissions are disabled until Memory Review, governed lifecycle, ' +
          'and authorization are enabled for this workspace.',
      };
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.memoryCandidate.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: 'pending',
          scope: { in: ['firm', 'client'] },
        },
        orderBy: { createdAt: 'asc' },
        take: 250,
        select: {
          id: true,
          proposedBy: true,
          sourceKind: true,
          scope: true,
          clientId: true,
          createdAt: true,
        },
      });
      const members = await activeTenantMembersInTx(tx, ctx.tenantId);
      const admin = ctx.role === 'user_admin' || ctx.role === 'capiro_admin';
      const counts = emptySummaryCounts();

      for (const row of rows) {
        const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, row.id);
        if (!subject) continue;
        const own = row.proposedBy === ctx.userId;
        let awaitingCurrentUser = false;
        let readableByAdmin = false;

        if (!own) {
          const approve = await this.authorization.evaluateInTx(tx, ctx, subject, 'approve', {
            emitDenialMetrics: false,
          });
          const review = approve.allowed
            ? approve
            : await this.authorization.evaluateInTx(tx, ctx, subject, 'review', {
                emitDenialMetrics: false,
              });
          awaitingCurrentUser = approve.allowed || review.allowed;
          if (admin && !awaitingCurrentUser) {
            const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read', {
              emitDenialMetrics: false,
            });
            readableByAdmin = read.allowed;
          }
        }

        const visible = own || awaitingCurrentUser || readableByAdmin;
        if (!visible) continue;

        counts.allPending += 1;
        if (own) counts.submittedByMe += 1;
        if (awaitingCurrentUser) counts.awaitingMyReview += 1;

        const reviewers = await this.eligibleReviewersInTx(tx, ctx.tenantId, subject, members);
        if (reviewers.length === 0) counts.blocked += 1;
      }

      return {
        enabled: true,
        counts,
        message:
          counts.blocked > 0
            ? `${counts.blocked} pending ${
                counts.blocked === 1 ? 'submission has' : 'submissions have'
              } no eligible independent reviewer.`
            : null,
      };
    });
  }

  private async syntheticSubjectInTx(
    tx: Prisma.TransactionClient,
    ctx: ReviewActorContext,
    input: SettingsMemoryCandidateInput,
  ): Promise<GovernedMemorySubjectRow> {
    let clientStatus: string | null = null;
    if (input.scope === 'client') {
      if (!input.clientId) throw new NotFoundException('Client memory requires a client.');
      const client = await tx.client.findFirst({
        where: { id: input.clientId, tenantId: ctx.tenantId },
        select: { status: true },
      });
      if (!client) throw new NotFoundException('Client memory target was not found.');
      clientStatus = client.status;
    }

    return {
      id: 'settings-submission-readiness',
      tenantId: ctx.tenantId,
      clientId: input.scope === 'client' ? input.clientId : null,
      ownerUserId: ctx.userId,
      proposedByUserId: ctx.userId,
      memoryClass: input.scope === 'client' ? 'client_steering' : 'institutional_authoritative',
      scope: input.scope,
      status: 'pending_review',
      legalHold: false,
      clientStatus,
    };
  }

  private async eligibleReviewersInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    subject: GovernedMemorySubjectRow,
    members: MemoryReviewerIdentity[],
  ): Promise<MemoryReviewerIdentity[]> {
    const reviewers: MemoryReviewerIdentity[] = [];
    for (const member of members) {
      if (member.userId === subject.proposedByUserId) continue;
      const decision = await this.authorization.evaluateInTx(
        tx,
        { tenantId, userId: member.userId, role: member.role },
        subject,
        'approve',
        { emitDenialMetrics: false },
      );
      if (decision.allowed) reviewers.push(member);
    }
    return reviewers;
  }
}

export function settingsMemoryReviewEnabledForTenant(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    clientMemoryReviewEnabled(env.MEMORY_CLIENT_REVIEW) &&
    governedMemoryModeEnabledForTenant(
      tenantId,
      env.MEMORY_GOVERNANCE_LIFECYCLE,
      env.MEMORY_GOVERNANCE_TENANTS,
    ) &&
    governedMemoryModeEnabledForTenant(
      tenantId,
      env.MEMORY_GOVERNANCE_ENFORCE,
      env.MEMORY_GOVERNANCE_TENANTS,
    )
  );
}

export function nextActionForPendingReview(input: {
  blocked: boolean;
  viewerIsProposer: boolean;
  viewerCanApprove: boolean;
  viewerCanReject: boolean;
  reviewers: MemoryReviewerIdentity[];
}): string {
  if (input.blocked) {
    return (
      'No eligible reviewer is currently available. Ask an administrator to add or ' +
      'authorize another reviewer.'
    );
  }
  if (input.viewerCanApprove && input.viewerCanReject) {
    return 'You can approve or reject this proposal under Settings → Memory → Needs my review.';
  }
  if (input.viewerCanApprove) {
    return 'You can approve this proposal under Settings → Memory → Needs my review.';
  }
  if (input.viewerCanReject) {
    return 'You can reject this proposal under Settings → Memory → Needs my review.';
  }
  if (input.viewerIsProposer) {
    const names = input.reviewers.map((reviewer) => reviewer.name).slice(0, 3);
    const reviewerText = names.length > 0 ? names.join(', ') : 'another authorized reviewer';
    return (
      `Waiting for ${reviewerText}. You cannot approve your own shared-memory submission. ` +
      'They can review it under Settings → Memory, and you can withdraw it under Your proposals.'
    );
  }
  return 'Waiting for an authorized independent reviewer.';
}

function memberRole(members: MemoryReviewerIdentity[], userId: string): TenantRole {
  return members.find((member) => member.userId === userId)?.role ?? 'standard_user';
}

function emptySummaryCounts(): MemoryReviewSummary['counts'] {
  return { awaitingMyReview: 0, submittedByMe: 0, allPending: 0, blocked: 0 };
}

async function activeTenantMembersInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<MemoryReviewerIdentity[]> {
  const rows = await tx.$queryRaw<ActiveTenantMemberRow[]>`
    SELECT tm.user_id::text AS "userId",
           tm.role::text AS role,
           u.email::text AS email,
           u.first_name AS "firstName",
           u.last_name AS "lastName"
    FROM tenant_memberships tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.tenant_id = ${tenantId}::uuid
      AND tm.status = 'active'
    ORDER BY lower(u.email::text), tm.user_id
  `;
  return rows.flatMap((row) => {
    const role = tenantRole(row.role);
    if (!role) return [];
    return [
      {
        userId: row.userId,
        role,
        email: row.email,
        name: displayName(row.firstName, row.lastName, row.email),
      },
    ];
  });
}

async function userIdentityInTx(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<MemoryReviewerIdentity> {
  const user = await tx.user.findFirst({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  return {
    userId,
    role: 'standard_user',
    email: user?.email ?? '',
    name: displayName(
      user?.firstName ?? null,
      user?.lastName ?? null,
      user?.email ?? 'Former user',
    ),
  };
}

function proposalFromPayload(payload: unknown): PendingSettingsReviewDetails['proposal'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { title: 'Proposed memory', sections: [] };
  }
  const record = payload as Record<string, unknown>;
  const canonical = record.canonicalItem;
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    return { title: readableString(record.key) ?? 'Proposed memory', sections: [] };
  }
  const item = canonical as Record<string, unknown>;
  const sections = Array.isArray(item.sections) ? item.sections.filter(isMemorySection) : [];
  return {
    title: readableString(item.title) ?? readableString(record.key) ?? 'Proposed memory',
    sections,
  };
}

function isMemorySection(value: unknown): value is MemorySection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const section = value as Record<string, unknown>;
  return (
    typeof section.key === 'string' &&
    typeof section.heading === 'string' &&
    (section.owner === 'human' || section.owner === 'engine') &&
    typeof section.body === 'string'
  );
}

function readableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tenantRole(value: string): TenantRole | null {
  return ['capiro_admin', 'user_admin', 'standard_user', 'client_portal_user'].includes(value)
    ? (value as TenantRole)
    : null;
}

function displayName(firstName: string | null, lastName: string | null, fallback: string): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || fallback;
}
