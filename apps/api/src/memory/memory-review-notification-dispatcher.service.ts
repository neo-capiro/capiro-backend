import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantRole } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { runWithMemoryGovernanceTenant } from './memory-governance-tenant-scope.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';
import { MemoryReviewNotificationEmailService } from './memory-review-notification-email.service.js';
import {
  isMemoryReviewNotificationEvent,
  memoryReviewNotificationMatchesWorkflow,
  memoryReviewNotificationOperation,
  normalizeNotificationTitle,
  type MemoryReviewNotificationEvent,
} from './memory-review-notification.helpers.js';

const MAX_ATTEMPTS = 8;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;

interface ClaimedNotificationRow {
  id: string;
  tenantId: string;
  reviewRequestId: string;
  candidateId: string;
  clientId: string | null;
  recipientUserId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  leaseToken: string;
  emailStatus: string | null;
}

interface RecipientWorkflowRow {
  role: string;
  email: string;
  workflowStatus: string;
  assignedTo: string | null;
  requestedBy: string | null;
  title: string;
  candidateKind: string | null;
}

interface AuthorizedDelivery {
  email: string;
  title: string;
  candidateKind: string;
  sendEmail: boolean;
  uncertainPriorEmailAttempt: boolean;
}

export interface MemoryReviewNotificationDispatchSummary {
  claimed: number;
  delivered: number;
  deferred: number;
  terminated: number;
  retried: number;
  emailSent: number;
  emailSuppressed: number;
  emailFailed: number;
}

@Injectable()
export class MemoryReviewNotificationDispatcherService {
  private readonly logger = new Logger(MemoryReviewNotificationDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly email: MemoryReviewNotificationEmailService,
  ) {}

  async dispatchBatch(
    requestedLimit = DEFAULT_BATCH_SIZE,
  ): Promise<MemoryReviewNotificationDispatchSummary> {
    const limit = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(requestedLimit)));
    const rows = await this.claim(limit);
    const summary: MemoryReviewNotificationDispatchSummary = {
      claimed: rows.length,
      delivered: 0,
      deferred: 0,
      terminated: 0,
      retried: 0,
      emailSent: 0,
      emailSuppressed: 0,
      emailFailed: 0,
    };

    for (const row of rows) {
      try {
        const outcome = await runWithMemoryGovernanceTenant(row.tenantId, () =>
          this.dispatchClaimed(row),
        );
        summary[outcome] += 1;
      } catch (error) {
        const retried = await this.releaseAfterFailure(row, error);
        summary[retried ? 'retried' : 'terminated'] += 1;
      }
    }

    return summary;
  }

  private async dispatchClaimed(
    row: ClaimedNotificationRow,
  ): Promise<
    | 'delivered'
    | 'deferred'
    | 'terminated'
    | 'emailSent'
    | 'emailSuppressed'
    | 'emailFailed'
  > {
    if (!memoryReviewSurfaceEnabled()) {
      await this.deferFeatureDisabled(row);
      return 'deferred';
    }
    if (!isMemoryReviewNotificationEvent(row.eventType)) {
      await this.terminate(row, 'unsupported_event_type');
      return 'terminated';
    }

    const authorized = await this.authorizeAndProject(row, row.eventType);
    if (!authorized) {
      await this.terminate(row, 'authorization_or_workflow_stale');
      return 'terminated';
    }

    let emailStatus: 'sent' | 'suppressed' | 'failed' = 'suppressed';
    let providerMessageId: string | null = null;
    if (authorized.uncertainPriorEmailAttempt) {
      emailStatus = 'failed';
    } else if (authorized.sendEmail) {
      const result = await this.email.send({
        outboxId: row.id,
        to: authorized.email,
        eventType: row.eventType,
        title: authorized.title,
        reviewRequestId: row.reviewRequestId,
      });
      if (result.sent) {
        emailStatus = 'sent';
        providerMessageId = result.messageId ?? null;
      } else if (result.suppressed) {
        emailStatus = 'suppressed';
      } else {
        emailStatus = 'failed';
      }
    }

    await this.complete(row, emailStatus, providerMessageId);
    if (emailStatus === 'sent') return 'emailSent';
    if (emailStatus === 'failed') return 'emailFailed';
    return 'emailSuppressed';
  }

  private async claim(limit: number): Promise<ClaimedNotificationRow[]> {
    const leaseToken = randomUUID();
    return this.prisma.withSystem((tx) =>
      tx.$queryRaw<ClaimedNotificationRow[]>(Prisma.sql`
        WITH claimable AS (
          SELECT id
          FROM memory_review_notification_outbox
          WHERE delivered_at IS NULL
            AND terminal_at IS NULL
            AND available_at <= now()
            AND attempts < ${MAX_ATTEMPTS}
            AND (leased_until IS NULL OR leased_until < now())
          ORDER BY created_at ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE memory_review_notification_outbox AS outbox
        SET lease_token = ${leaseToken}::uuid,
            leased_until = now() + interval '5 minutes',
            last_attempt_at = now(),
            attempts = outbox.attempts + 1
        FROM claimable
        WHERE outbox.id = claimable.id
        RETURNING outbox.id::text AS id,
                  outbox.tenant_id::text AS "tenantId",
                  outbox.review_request_id::text AS "reviewRequestId",
                  outbox.candidate_id::text AS "candidateId",
                  outbox.client_id::text AS "clientId",
                  outbox.recipient_user_id::text AS "recipientUserId",
                  outbox.event_type AS "eventType",
                  outbox.payload_jsonb AS payload,
                  outbox.attempts,
                  outbox.lease_token::text AS "leaseToken",
                  outbox.email_status AS "emailStatus"
      `),
    );
  }

  private async authorizeAndProject(
    row: ClaimedNotificationRow,
    eventType: MemoryReviewNotificationEvent,
  ): Promise<AuthorizedDelivery | null> {
    return this.prisma.withTenantUser(
      row.tenantId,
      row.recipientUserId,
      async (tx): Promise<AuthorizedDelivery | null> => {
        const rows = await tx.$queryRaw<RecipientWorkflowRow[]>(Prisma.sql`
          SELECT tm.role::text AS role,
                 u.email::text AS email,
                 rr.status AS "workflowStatus",
                 rr.assigned_to::text AS "assignedTo",
                 rr.requested_by::text AS "requestedBy",
                 rr.title,
                 rr.payload_jsonb ->> 'candidateKind' AS "candidateKind"
          FROM review_request rr
          JOIN tenant_memberships tm
            ON tm.tenant_id = rr.tenant_id
           AND tm.user_id = ${row.recipientUserId}::uuid
           AND tm.status = 'active'
          JOIN users u ON u.id = tm.user_id
          WHERE rr.tenant_id = ${row.tenantId}::uuid
            AND rr.id = ${row.reviewRequestId}::uuid
            AND rr.surface = 'memory'
            AND rr.subject_type = 'memory_candidate'
            AND rr.subject_id = ${row.candidateId}
          LIMIT 1
        `);
        const workflow = rows[0];
        if (!workflow) return null;
        const role = tenantRole(workflow.role);
        if (!role) return null;
        if (
          !memoryReviewNotificationMatchesWorkflow(eventType, row.recipientUserId, {
            status: workflow.workflowStatus,
            assignedTo: workflow.assignedTo,
            requestedBy: workflow.requestedBy,
          })
        ) {
          return null;
        }

        const subject = await this.authorization.loadCandidateInTx(
          tx,
          row.tenantId,
          row.candidateId,
        );
        if (!subject) return null;
        const decision = await this.authorization.evaluateInTx(
          tx,
          { tenantId: row.tenantId, userId: row.recipientUserId, role },
          subject,
          memoryReviewNotificationOperation(eventType),
          { emitDenialMetrics: false },
        );
        if (!decision.allowed) return null;

        const title = normalizeNotificationTitle(workflow.title);
        const candidateKind = workflow.candidateKind?.trim() || 'standard';
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO memory_review_in_app_notification (
            tenant_id,
            recipient_user_id,
            review_request_id,
            candidate_id,
            client_id,
            event_type,
            title,
            metadata_jsonb
          ) VALUES (
            ${row.tenantId}::uuid,
            ${row.recipientUserId}::uuid,
            ${row.reviewRequestId}::uuid,
            ${row.candidateId}::uuid,
            ${row.clientId}::uuid,
            ${eventType},
            ${title},
            jsonb_build_object(
              'workflow', 'memory_review_v2',
              'schemaVersion', 1,
              'reviewRequestId', ${row.reviewRequestId}::uuid,
              'candidateId', ${row.candidateId}::uuid,
              'clientId', ${row.clientId}::uuid,
              'eventType', ${eventType},
              'candidateKind', ${candidateKind},
              'requiresCurrentAuthorization', true
            )
          )
          ON CONFLICT (
            tenant_id,
            recipient_user_id,
            review_request_id,
            event_type
          ) DO NOTHING
        `);

        const uncertainPriorEmailAttempt = row.emailStatus === 'sending';
        let sendEmail = false;
        if (row.emailStatus === null) {
          if (this.email.enabled()) {
            const reserved = await tx.$executeRaw(Prisma.sql`
              UPDATE memory_review_notification_outbox
              SET email_status = 'sending'
              WHERE id = ${row.id}::uuid
                AND tenant_id = ${row.tenantId}::uuid
                AND lease_token = ${row.leaseToken}::uuid
                AND email_status IS NULL
            `);
            sendEmail = reserved === 1;
          } else {
            await tx.$executeRaw(Prisma.sql`
              UPDATE memory_review_notification_outbox
              SET email_status = 'suppressed'
              WHERE id = ${row.id}::uuid
                AND tenant_id = ${row.tenantId}::uuid
                AND lease_token = ${row.leaseToken}::uuid
                AND email_status IS NULL
            `);
          }
        }

        return {
          email: workflow.email,
          title,
          candidateKind,
          sendEmail,
          uncertainPriorEmailAttempt,
        };
      },
    );
  }

  private async complete(
    row: ClaimedNotificationRow,
    emailStatus: 'sent' | 'suppressed' | 'failed',
    providerMessageId: string | null,
  ): Promise<void> {
    await this.prisma.withTenantUser(row.tenantId, row.recipientUserId, async (tx) => {
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE memory_review_notification_outbox
        SET delivered_at = now(),
            lease_token = NULL,
            leased_until = NULL,
            email_status = ${emailStatus},
            provider_message_id = ${providerMessageId},
            last_error = NULL
        WHERE id = ${row.id}::uuid
          AND tenant_id = ${row.tenantId}::uuid
          AND lease_token = ${row.leaseToken}::uuid
          AND delivered_at IS NULL
          AND terminal_at IS NULL
      `);
      if (updated !== 1) throw new Error('MEMORY_REVIEW_NOTIFICATION_LEASE_LOST');
      await tx.auditLog.create({
        data: {
          tenantId: row.tenantId,
          actorUserId: null,
          actorRole: 'system',
          action: 'memory.review.notification.delivered',
          entityType: 'memory_review_notification_outbox',
          entityId: row.id,
          before: { delivered: false },
          after: {
            delivered: true,
            reviewRequestId: row.reviewRequestId,
            candidateId: row.candidateId,
            recipientUserId: row.recipientUserId,
            eventType: row.eventType,
            inAppStatus: 'created',
            emailStatus,
          },
        },
      });
    });
  }

  private async deferFeatureDisabled(row: ClaimedNotificationRow): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.$executeRaw(Prisma.sql`
        UPDATE memory_review_notification_outbox
        SET lease_token = NULL,
            leased_until = NULL,
            attempts = GREATEST(attempts - 1, 0),
            available_at = now() + interval '30 minutes',
            last_error = 'feature_disabled'
        WHERE id = ${row.id}::uuid
          AND lease_token = ${row.leaseToken}::uuid
      `),
    );
  }

  private async terminate(row: ClaimedNotificationRow, code: string): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.$executeRaw(Prisma.sql`
        UPDATE memory_review_notification_outbox
        SET terminal_at = now(),
            lease_token = NULL,
            leased_until = NULL,
            last_error = ${code.slice(0, 120)}
        WHERE id = ${row.id}::uuid
          AND lease_token = ${row.leaseToken}::uuid
          AND delivered_at IS NULL
      `),
    );
  }

  private async releaseAfterFailure(
    row: ClaimedNotificationRow,
    error: unknown,
  ): Promise<boolean> {
    const terminal = row.attempts >= MAX_ATTEMPTS;
    const delayMinutes = Math.min(60, 2 ** Math.min(row.attempts, 6));
    const code = dispatcherErrorCode(error);
    this.logger.warn(`Memory review notification ${row.id} failed with ${code}.`);
    await this.prisma.withSystem((tx) =>
      tx.$executeRaw(Prisma.sql`
        UPDATE memory_review_notification_outbox
        SET lease_token = NULL,
            leased_until = NULL,
            terminal_at = CASE WHEN ${terminal} THEN now() ELSE terminal_at END,
            available_at = CASE
              WHEN ${terminal} THEN available_at
              ELSE now() + (${delayMinutes} * interval '1 minute')
            END,
            last_error = ${code}
        WHERE id = ${row.id}::uuid
          AND lease_token = ${row.leaseToken}::uuid
          AND delivered_at IS NULL
      `),
    );
    return !terminal;
  }
}

function tenantRole(value: string): TenantRole | null {
  return ['capiro_admin', 'user_admin', 'standard_user', 'client_portal_user'].includes(value)
    ? (value as TenantRole)
    : null;
}

function dispatcherErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === 'MEMORY_REVIEW_NOTIFICATION_LEASE_LOST') {
    return 'lease_lost';
  }
  const name = error instanceof Error ? error.name : 'unknown_error';
  return `dispatcher_error:${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
}
