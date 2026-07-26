/**
 * Engagement Phase 0 (plan §3.d1) — durable send intents + at-most-once delivery.
 *
 * The invariant this service exists to guarantee:
 *
 *   NO EXTERNAL PROVIDER CALL HAPPENS BEFORE THE INTENT AND ITS DELIVERY ROWS
 *   ARE COMMITTED.
 *
 * The previous path called Graph/Gmail first and persisted afterwards, so a
 * crash (or a failed write) between acceptance and persistence produced an
 * unrecorded external send — invisible in the Sent history, impossible to
 * reconcile, and indistinguishable from "never sent" on retry.
 *
 * It also accepts DRAFT VERSION IDS ONLY. There is no code path here that takes
 * caller-supplied subject/body, which is what makes "every sent delivery
 * references an immutable audited version" true by construction rather than by
 * convention.
 *
 * At-most-once, precisely:
 *   • a delivery is claimed with a status-guarded UPDATE (pending → sending)
 *     that exactly one worker can win, committed BEFORE the provider call;
 *   • the provider call happens outside any transaction;
 *   • a clear pre-acceptance rejection → 'failed' (a human may create a NEW
 *     intent);
 *   • ANY ambiguity — timeout, socket death after the request body went out, a
 *     success response without a message id — → 'unknown', which is NEVER
 *     returned to 'pending' and NEVER retried automatically;
 *   • a crashed worker leaves 'sending', and reconciliation ages that to
 *     'unknown', never back to 'pending'.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from './engagement.service.js';
import { EngagementMailSender, AmbiguousMailSendError } from './mail-sender.service.js';
import {
  appendOutreachSignature,
  renderOutreachBody,
} from './outreach-email-renderer.js';
import { isDraftVersionSendable, type OutreachDeliveryStatus } from './outreach-draft.types.js';

/** Graph/Gmail simple-send inline attachment ceiling. */
const INLINE_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
const MAX_DRAFT_VERSIONS_PER_INTENT = 500;
const MAX_ATTACHMENTS_PER_INTENT = 25;

export interface CreateSendIntentInput {
  outreachRecordId: string;
  requestKey: string;
  senderConnectionId: string;
  draftVersionIds: string[];
  attachmentIds?: string[];
  appendSignature?: boolean;
  testMode?: boolean;
}

export interface OutreachDeliveryView {
  id: string;
  generationKey: string;
  recipientKey: string;
  status: OutreachDeliveryStatus;
  attempt: number;
  provider: string;
  correlationId: string;
  to: Array<{ email: string; name?: string | null }>;
  cc: string[];
  bcc: string[];
  subject: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  providerDraftId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  acceptedAt: string | null;
}

export interface OutreachSendIntentView {
  id: string;
  outreachRecordId: string;
  status: string;
  testMode: boolean;
  requestKey: string;
  totals: Record<string, number>;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  deliveries: OutreachDeliveryView[];
}

interface RecipientEnvelope {
  to: Array<{ email: string; name?: string | null }>;
  cc: string[];
  bcc: string[];
}

interface AttachmentManifestEntry {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}

@Injectable()
export class OutreachSendIntentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachSendIntentService.name);
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private readonly sweepMs: number;
  private readonly staleMs: number;
  private readonly versionedOutreach: boolean;
  private readonly externalSendV2Required: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    private readonly mailSender: EngagementMailSender,
    config: ConfigService<AppConfig, true>,
  ) {
    this.sweepMs = config.get('OUTREACH_JOB_SWEEP_MS', { infer: true });
    this.staleMs = config.get('OUTREACH_JOB_STALE_MS', { infer: true });
    this.versionedOutreach = config.get('ENGAGEMENT_VERSIONED_OUTREACH', { infer: true });
    this.externalSendV2Required = config.get('ENGAGEMENT_EXTERNAL_SEND_V2_REQUIRED', {
      infer: true,
    });
  }

  onModuleInit(): void {
    // The worker only runs where versioned outreach is enabled; with the flag off
    // no intents can be created, so a sweep would be pure load.
    if (!this.versionedOutreach) return;
    this.timer = setInterval(() => {
      if (this.sweeping) return; // overlap-skip: a slow provider must not stack ticks
      this.sweeping = true;
      this.runSweep()
        .catch((err) =>
          this.logger.error(`outreach send-intent sweep failed: ${(err as Error).message}`),
        )
        .finally(() => {
          this.sweeping = false;
        });
    }, this.sweepMs);
    this.timer.unref?.();
    this.logger.log(`outreach send-intent worker started (every ${this.sweepMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── createIntent ──────────────────────────────────────────────────────────

  /**
   * Validate everything, render the exact outbound text, then commit the intent
   * and one delivery per logical send unit in ONE transaction.
   *
   * DEVIATION (documented): the plan lists validation, attachment resolution and
   * body rendering as steps inside the write transaction. Attachment resolution
   * reads S3, and holding a Postgres transaction open across S3 round-trips is
   * the exact shape of a prior production incident in this codebase (a lock held
   * across a slow read starved the Prisma pool). Read-only validation and
   * rendering therefore happen BEFORE the transaction, and the version states are
   * RE-CHECKED inside it so a version edited in the meantime cannot slip through.
   * The invariant that matters is unchanged: nothing external is called until
   * after commit.
   */
  async createIntent(
    ctx: TenantContext,
    input: CreateSendIntentInput,
  ): Promise<{ intentId: string; deduped: boolean }> {
    const requestKey = input.requestKey?.trim() ?? '';
    if (requestKey.length < 8 || requestKey.length > 128) {
      throw new BadRequestException('requestKey must be 8–128 characters.');
    }
    const versionIds = input.draftVersionIds ?? [];
    if (!versionIds.length) throw new BadRequestException('No draft versions to send.');
    if (versionIds.length > MAX_DRAFT_VERSIONS_PER_INTENT) {
      throw new BadRequestException(
        `Send at most ${MAX_DRAFT_VERSIONS_PER_INTENT} drafts per intent.`,
      );
    }
    if (new Set(versionIds).size !== versionIds.length) {
      throw new BadRequestException('Duplicate draft version ids in the same send.');
    }
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_INTENT) {
      throw new BadRequestException(`Attach at most ${MAX_ATTACHMENTS_PER_INTENT} files.`);
    }

    const testMode = input.testMode === true;

    // 1. The parent record must be a draft this user owns.
    const outreachRecordId = await this.assertOwnedRecord(ctx, input.outreachRecordId);

    // 2. The sending mailbox must be a connected inbox THIS user owns. Reuses the
    //    production resolver so provider-ownership rules cannot drift.
    const connection = await this.engagement.findCampaignSendConnection(
      ctx,
      input.senderConnectionId,
    );

    // 3. Load every requested version with its artifact + current version.
    const versions = await this.loadSendableVersions(ctx, versionIds, testMode);

    // 4. Attachments: resolved, size-checked and REJECTED up front. A file over
    //    the inline limit fails intent creation — it is never silently skipped,
    //    which is how recipients previously received mail missing the document
    //    the whole email was about.
    const { manifest, inlineAttachments } = await this.resolveAttachments(ctx, attachmentIds);

    // 5. Signature + rendering captured ONCE, now.
    const signature = await this.engagement.resolveSenderSignatureHtml(ctx, input.appendSignature);
    if (testMode && !signature.senderEmail) {
      throw new BadRequestException('Your user has no email on file for a test send.');
    }

    const provider = connection.provider === 'google_workspace' ? 'gmail' : 'microsoft_graph';
    const planned = versions.map((v) => {
      const envelope = testMode
        ? {
            to: [{ email: signature.senderEmail!, name: signature.senderFirstName }],
            cc: [],
            bcc: [],
          }
        : buildEnvelope(v.artifact.recipientSnapshot);
      if (!testMode && envelope.to.length === 0) {
        // Edge case 12/13: an empty group or a recipient with no email is a
        // validation failure BEFORE the intent exists, not a delivery that fails
        // later or a group that silently sends to nobody.
        throw new BadRequestException(
          `No valid email address for "${v.artifact.generationKey}". ` +
            `Fix the recipient before sending.`,
        );
      }
      const rendered = appendOutreachSignature(
        renderOutreachBody(v.body),
        signature.signatureHtml,
      );
      const subject = testMode ? `[TEST] ${v.subject || 'Outreach preview'}` : v.subject;
      return {
        versionId: v.id,
        generationKey: v.artifact.generationKey,
        recipientKey: v.artifact.recipientKey,
        envelope,
        renderedSubject: subject,
        renderedBody: rendered.content,
        idempotencyKey: deliveryIdempotencyKey({
          tenantId: ctx.tenantId,
          senderConnectionId: connection.id,
          draftVersionId: v.id,
          envelope,
          manifest,
          testMode,
        }),
      };
    });

    // 6. Commit intent + deliveries atomically. Nothing external has been called.
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachSendIntent.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, requestKey },
        select: { id: true },
      });
      // Edge case 9: a duplicate request key returns the EXISTING intent and
      // creates nothing. The provider is not called a second time.
      if (existing) return { intentId: existing.id, deduped: true };

      // TOCTOU re-check: sendability is re-read inside the write transaction, so
      // a version edited/held between validation and commit cannot be sent.
      const stillCurrent = await tx.outreachDraftVersion.findMany({
        where: { id: { in: planned.map((p) => p.versionId) }, tenantId: ctx.tenantId },
        select: {
          id: true,
          version: true,
          auditStatus: true,
          approvalStatus: true,
          artifact: { select: { currentVersion: true } },
        },
      });
      for (const v of stillCurrent) {
        if (
          v.version !== v.artifact.currentVersion ||
          !isDraftVersionSendable({
            auditStatus: v.auditStatus as never,
            approvalStatus: v.approvalStatus as never,
          })
        ) {
          throw new ConflictException(
            'A draft changed while the send was being prepared. Reload and try again.',
          );
        }
      }

      const intent = await tx.outreachSendIntent.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outreachRecordId,
          senderConnectionId: connection.id,
          requestKey,
          appendSignature: signature.appendSignature,
          attachmentIds: attachmentIds as unknown as object,
          testMode,
          status: 'queued',
          totals: { total: planned.length, pending: planned.length } as unknown as object,
        },
        select: { id: true },
      });

      for (const p of planned) {
        try {
          await tx.outreachDelivery.create({
            data: {
              tenantId: ctx.tenantId,
              sendIntentId: intent.id,
              draftVersionId: p.versionId,
              generationKey: p.generationKey.slice(0, 512),
              recipientKey: p.recipientKey.slice(0, 256),
              recipientEnvelope: p.envelope as unknown as object,
              idempotencyKey: p.idempotencyKey,
              renderedSubject: p.renderedSubject,
              renderedBody: p.renderedBody,
              attachmentManifest: manifest as unknown as object,
              provider,
              status: 'pending',
            },
          });
        } catch (e) {
          // Edge case 10: the SAME exact delivery under a different request key.
          // The unique (tenant, idempotencyKey) index refuses it, so a duplicate
          // send is impossible even with a fresh key. Surface the conflict with
          // ids only — never the recipient's content.
          if (isUniqueViolation(e)) {
            throw new ConflictException({
              statusCode: 409,
              error: 'OUTREACH_DELIVERY_ALREADY_EXISTS',
              message:
                'This exact draft has already been submitted for delivery to these recipients. ' +
                'Open the existing send to see its result.',
              generationKey: p.generationKey,
            });
          }
          throw e;
        }
      }

      // Kept for the worker: bytes are re-read at send time from the manifest,
      // so nothing large is stored on the intent.
      void inlineAttachments;
      return { intentId: intent.id, deduped: false };
    });
  }

  // ── Reads / cancel ────────────────────────────────────────────────────────

  async getIntent(ctx: TenantContext, intentId: string): Promise<OutreachSendIntentView> {
    const intent = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachSendIntent.findFirst({
        // Owner-scoped: a send intent is private to the user who created it.
        where: { id: intentId, tenantId: ctx.tenantId, userId: ctx.userId },
        include: { deliveries: { orderBy: { createdAt: 'asc' } } },
      }),
    );
    if (!intent) throw new NotFoundException('Send intent not found');
    return {
      id: intent.id,
      outreachRecordId: intent.outreachRecordId,
      status: intent.status,
      testMode: intent.testMode,
      requestKey: intent.requestKey,
      totals: (intent.totals ?? {}) as Record<string, number>,
      error: intent.error,
      startedAt: intent.startedAt?.toISOString() ?? null,
      finishedAt: intent.finishedAt?.toISOString() ?? null,
      createdAt: intent.createdAt.toISOString(),
      deliveries: intent.deliveries.map((d) => {
        const env = (d.recipientEnvelope ?? {}) as Partial<RecipientEnvelope>;
        return {
          id: d.id,
          generationKey: d.generationKey,
          recipientKey: d.recipientKey,
          status: d.status as OutreachDeliveryStatus,
          attempt: d.attempt,
          provider: d.provider,
          correlationId: d.correlationId,
          to: env.to ?? [],
          cc: env.cc ?? [],
          bcc: env.bcc ?? [],
          subject: d.renderedSubject,
          providerMessageId: d.providerMessageId,
          providerThreadId: d.providerThreadId,
          providerDraftId: d.providerDraftId,
          errorCode: d.errorCode,
          errorMessage: d.errorMessage,
          acceptedAt: d.acceptedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  /**
   * Cancel what has not left yet.
   *
   * Only 'pending' rows become 'skipped'. A row already in 'sending' is in flight
   * at the provider and is deliberately left alone — claiming otherwise would
   * tell the user a message was cancelled when it may well have been delivered
   * (edge case 23). Sent/unknown rows are terminal.
   */
  async cancelIntent(
    ctx: TenantContext,
    intentId: string,
  ): Promise<{ canceled: boolean; skipped: number; inFlight: number; terminal: number }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const intent = await tx.outreachSendIntent.findFirst({
        where: { id: intentId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { id: true, status: true },
      });
      if (!intent) throw new NotFoundException('Send intent not found');

      const skipped = await tx.outreachDelivery.updateMany({
        where: { sendIntentId: intentId, tenantId: ctx.tenantId, status: 'pending' },
        data: { status: 'skipped' },
      });
      const inFlight = await tx.outreachDelivery.count({
        where: { sendIntentId: intentId, tenantId: ctx.tenantId, status: 'sending' },
      });
      const terminal = await tx.outreachDelivery.count({
        where: {
          sendIntentId: intentId,
          tenantId: ctx.tenantId,
          status: { in: ['sent', 'unknown', 'failed'] },
        },
      });
      const canceled = !['complete', 'failed', 'canceled'].includes(intent.status);
      if (canceled && inFlight === 0) {
        await tx.outreachSendIntent.update({
          where: { id: intentId },
          data: { status: 'canceled', finishedAt: new Date() },
        });
      }
      return { canceled, skipped: skipped.count, inFlight, terminal };
    });
  }

  // ── Worker ────────────────────────────────────────────────────────────────

  async runSweep(): Promise<void> {
    await this.reconcileStale();
    const intentId = await this.findRunnableIntentId();
    if (!intentId) return;
    await this.processIntent(intentId);
  }

  private async findRunnableIntentId(): Promise<string | null> {
    return this.prisma.withSystem(async (tx) => {
      const row = await tx.outreachSendIntent.findFirst({
        where: {
          status: { in: ['queued', 'running'] },
          deliveries: { some: { status: 'pending' } },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      return row?.id ?? null;
    });
  }

  private async processIntent(intentId: string): Promise<void> {
    const intent = await this.prisma.withSystem((tx) =>
      tx.outreachSendIntent.findFirst({
        where: { id: intentId },
        select: {
          id: true,
          tenantId: true,
          userId: true,
          senderConnectionId: true,
          status: true,
          testMode: true,
          outreachRecordId: true,
          senderConnection: { select: { id: true, provider: true } },
        },
      }),
    );
    if (!intent) return;

    if (intent.status === 'queued') {
      await this.prisma.withSystem((tx) =>
        tx.outreachSendIntent.updateMany({
          where: { id: intentId, status: 'queued' },
          data: { status: 'running', startedAt: new Date() },
        }),
      );
    }

    const ctx = workerContext(intent.tenantId, intent.userId);
    for (;;) {
      const claimed = await this.claimNextDelivery(intentId);
      if (!claimed) break;
      await this.deliverClaimed(ctx, intent.senderConnection, claimed);
      await this.rollUpIntent(intentId);
      // Gentle pacing (~1.5/sec), well under provider limits.
      await sleep(650);
    }
    await this.rollUpIntent(intentId);
  }

  /**
   * Atomically claim ONE pending delivery: pending → sending, claimedAt set,
   * attempt incremented. The status predicate is the at-most-once gate — exactly
   * one worker can win the row, and the claim is COMMITTED before any provider
   * request goes out, so a crash can never look like "never attempted".
   */
  private async claimNextDelivery(intentId: string): Promise<ClaimedDelivery | null> {
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<ClaimedDeliveryRow>>`
        UPDATE outreach_deliveries SET
          status = 'sending',
          claimed_at = NOW(),
          attempt = attempt + 1,
          updated_at = NOW()
        WHERE id = (
          SELECT id FROM outreach_deliveries
          WHERE send_intent_id = ${intentId}::uuid AND status = 'pending'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, draft_version_id, generation_key, correlation_id,
                  rendered_subject, rendered_body, recipient_envelope_jsonb,
                  attachment_manifest_jsonb, provider
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        draftVersionId: row.draft_version_id,
        generationKey: row.generation_key,
        correlationId: row.correlation_id,
        renderedSubject: row.rendered_subject,
        renderedBody: row.rendered_body,
        envelope: (row.recipient_envelope_jsonb ?? {}) as RecipientEnvelope,
        manifest: (row.attachment_manifest_jsonb ?? []) as AttachmentManifestEntry[],
        provider: row.provider,
      };
    });
  }

  /** Provider call — outside every transaction — then persist the outcome. */
  private async deliverClaimed(
    ctx: TenantContext,
    connection: { id: string; provider: string },
    delivery: ClaimedDelivery,
  ): Promise<void> {
    // Edge case 16: an attachment deleted between intent creation and send. The
    // delivery FAILS rather than going out without the document it promised.
    let attachments: Array<{ name: string; contentType: string; contentBytes: string }> | undefined;
    try {
      attachments = await this.loadManifestBytes(ctx, delivery.manifest);
    } catch (e) {
      await this.finishDelivery(delivery.id, 'failed', {
        errorCode: 'ATTACHMENT_UNAVAILABLE',
        errorMessage: truncateError((e as Error).message),
      });
      return;
    }

    try {
      const result = await this.mailSender.sendMail(
        ctx,
        connection as never,
        {
          subject: delivery.renderedSubject,
          body: delivery.renderedBody,
          bodyContentType: 'HTML',
          toRecipients: delivery.envelope.to ?? [],
          ccRecipients: (delivery.envelope.cc ?? []).map((email) => ({ email })),
          bccRecipients: (delivery.envelope.bcc ?? []).map((email) => ({ email })),
          correlationId: delivery.correlationId,
          ...(attachments?.length ? { attachments } : {}),
        },
      );
      // Edge case 20: the provider ACCEPTED. If this write fails we retry only
      // the local persistence using the already-claimed row — never the send.
      await this.persistAcceptance(delivery.id, {
        providerMessageId: result.providerMessageId ?? null,
        providerThreadId: result.providerThreadId ?? null,
        providerDraftId: result.providerDraftId ?? null,
        providerInternetMessageId: result.providerInternetMessageId ?? null,
      });
    } catch (err) {
      if (err instanceof AmbiguousMailSendError) {
        // Edge cases 18/21/22: acceptance is UNKNOWN. Terminal for automation.
        await this.finishDelivery(delivery.id, 'unknown', {
          errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
          errorMessage: truncateError(err.message),
          providerDraftId: err.providerDraftId ?? null,
        });
        this.logger.error(
          `delivery ${delivery.id} outcome UNKNOWN (correlation ${delivery.correlationId}) — ` +
            `NOT retrying; a human must verify Sent Items.`,
        );
        return;
      }
      // Edge case 17: a clear pre-acceptance rejection. Eligible for an explicit
      // new intent, never an automatic retry.
      await this.finishDelivery(delivery.id, 'failed', {
        errorCode: classifyProviderError(err),
        errorMessage: truncateError((err as Error).message),
      });
    }
  }

  /**
   * Persist provider acceptance. Retried a few times because the message is
   * already gone: losing the record would be worse than a slow write, and the
   * provider is deliberately NOT called again.
   */
  private async persistAcceptance(
    deliveryId: string,
    ids: {
      providerMessageId: string | null;
      providerThreadId: string | null;
      providerDraftId: string | null;
      providerInternetMessageId: string | null;
    },
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.prisma.withSystem((tx) =>
          tx.outreachDelivery.updateMany({
            where: { id: deliveryId },
            data: {
              status: 'sent',
              acceptedAt: new Date(),
              // Bounded strings only — never raw provider JSON (edge case 30).
              providerMessageId: boundedId(ids.providerMessageId),
              providerThreadId: boundedId(ids.providerThreadId),
              providerDraftId: boundedId(ids.providerDraftId),
              providerInternetMessageId: boundedId(ids.providerInternetMessageId),
              errorCode: null,
              errorMessage: null,
            },
          }),
        );
        return;
      } catch (e) {
        lastErr = e;
        await sleep(250 * (attempt + 1));
      }
    }
    this.logger.error(
      `delivery ${deliveryId} WAS ACCEPTED by the provider but its result could not be ` +
        `persisted after 3 attempts — the provider was NOT called again: ${(lastErr as Error)?.message}`,
    );
  }

  private async finishDelivery(
    deliveryId: string,
    status: OutreachDeliveryStatus,
    extra: {
      errorCode?: string | null;
      errorMessage?: string | null;
      providerDraftId?: string | null;
    },
  ): Promise<void> {
    await this.prisma
      .withSystem((tx) =>
        tx.outreachDelivery.updateMany({
          where: { id: deliveryId },
          data: {
            status,
            errorCode: extra.errorCode ?? null,
            errorMessage: extra.errorMessage ?? null,
            ...(extra.providerDraftId ? { providerDraftId: boundedId(extra.providerDraftId) } : {}),
          },
        }),
      )
      .catch((e) =>
        this.logger.error(`could not finish delivery ${deliveryId}: ${(e as Error).message}`),
      );
  }

  /**
   * Age abandoned claims to 'unknown' — NEVER back to 'pending'.
   *
   * A row stuck in 'sending' means a worker died after committing its claim. It
   * may or may not have reached the provider, so re-sending it would risk a
   * duplicate external email. This is the one place the difference between
   * at-least-once and at-most-once actually gets decided.
   */
  private async reconcileStale(): Promise<void> {
    const cutoff = new Date(Date.now() - this.staleMs);
    await this.prisma.withSystem((tx) =>
      tx.outreachDelivery.updateMany({
        where: { status: 'sending', claimedAt: { lt: cutoff } },
        data: {
          status: 'unknown',
          errorCode: 'WORKER_ABANDONED_CLAIM',
          errorMessage: 'The sender restarted while this delivery was in flight.',
        },
      }),
    );
  }

  /**
   * Recompute intent totals and mirror the summary onto the OutreachRecord.
   *
   * The INTENT is authoritative: if the OutreachRecord summary update fails, only
   * that local summary is retried — the provider is never called again.
   */
  private async rollUpIntent(intentId: string): Promise<void> {
    const summary = await this.prisma.withSystem(async (tx) => {
      const intent = await tx.outreachSendIntent.findFirst({
        where: { id: intentId },
        select: { id: true, status: true, outreachRecordId: true, tenantId: true, testMode: true },
      });
      if (!intent) return null;
      const rows = await tx.outreachDelivery.findMany({
        where: { sendIntentId: intentId },
        select: { status: true },
      });
      const totals = countByStatus(rows.map((r) => r.status as OutreachDeliveryStatus));
      const status = rollUpStatus(totals);
      const done = status === 'complete' || status === 'partial' || status === 'failed';
      // Cancel is terminal: never overwrite it with a rollup.
      await tx.outreachSendIntent.updateMany({
        where: { id: intentId, status: { not: 'canceled' } },
        data: {
          status,
          totals: totals as unknown as object,
          ...(done ? { finishedAt: new Date() } : {}),
        },
      });
      return { intent, totals, status, done };
    });
    if (!summary || !summary.done || summary.intent.testMode) return;

    // Mirror onto the campaign record so Outreach → Sent reflects reality.
    try {
      const { intent, totals } = summary;
      const anySent = (totals.sent ?? 0) > 0;
      await this.prisma.withSystem((tx) =>
        tx.outreachRecord.updateMany({
          where: { id: intent.outreachRecordId, tenantId: intent.tenantId },
          data: {
            status: anySent ? 'sent' : 'failed',
            ...(anySent ? { sentAt: new Date() } : {}),
            stats: {
              provider: 'send_intent',
              sendIntentId: intent.id,
              recipientsAttempted: totals.total ?? 0,
              recipientsSent: totals.sent ?? 0,
              recipientsFailed: totals.failed ?? 0,
              recipientsUnknown: totals.unknown ?? 0,
              recipientsSkipped: totals.skipped ?? 0,
              // Opens are NOT tracked — no pixels, no link rewriting (D8).
              replyCount: 0,
            } as unknown as object,
          },
        }),
      );
    } catch (e) {
      this.logger.warn(
        `send intent ${intentId} is authoritative but its OutreachRecord summary update failed ` +
          `(no provider call is repeated): ${(e as Error).message}`,
      );
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async assertOwnedRecord(ctx: TenantContext, outreachRecordId: string): Promise<string> {
    const record = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachRecord.findFirst({
        where: { id: outreachRecordId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, createdByUserId: true },
      }),
    );
    if (!record || record.createdByUserId !== ctx.userId) {
      throw new NotFoundException('Outreach draft record not found');
    }
    return record.id;
  }

  /**
   * Load the requested versions and refuse anything not safe to send: a
   * superseded version, a version that fails the audit/approval gate, or (when
   * the v2 gate is on) a REAL send of a legacy-prompt draft.
   */
  private async loadSendableVersions(ctx: TenantContext, versionIds: string[], testMode: boolean) {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftVersion.findMany({
        where: { id: { in: versionIds }, tenantId: ctx.tenantId },
        select: {
          id: true,
          version: true,
          subject: true,
          body: true,
          auditStatus: true,
          approvalStatus: true,
          promptSpecVersion: true,
          artifact: {
            select: {
              id: true,
              currentVersion: true,
              generationKey: true,
              recipientKey: true,
              recipientSnapshot: true,
              createdByUserId: true,
              outreachRecordId: true,
            },
          },
        },
      }),
    );
    if (rows.length !== versionIds.length) {
      throw new NotFoundException('One or more drafts could not be found.');
    }
    for (const v of rows) {
      if (v.artifact.createdByUserId !== ctx.userId) {
        // Owner-private: same 404 as missing (no existence leak).
        throw new NotFoundException('One or more drafts could not be found.');
      }
      if (v.version !== v.artifact.currentVersion) {
        throw new ConflictException(
          'A newer version of one of these drafts exists. Reload before sending.',
        );
      }
      if (
        !isDraftVersionSendable({
          auditStatus: v.auditStatus as never,
          approvalStatus: v.approvalStatus as never,
        })
      ) {
        throw new BadRequestException(
          `A draft is not cleared for sending (verification: ${v.auditStatus}, review: ${v.approvalStatus}).`,
        );
      }
      if (this.externalSendV2Required && !testMode && !isPromptSpecV2OrLater(v.promptSpecVersion)) {
        throw new BadRequestException(
          'This draft was written with the legacy prompt; external send is blocked. Regenerate it before sending.',
        );
      }
    }
    return rows;
  }

  /**
   * Resolve attachments and REJECT any file over the provider inline limit before
   * the intent exists. The old path skipped oversized files after sending and
   * merely reported it — recipients got mail missing its document.
   */
  private async resolveAttachments(
    ctx: TenantContext,
    attachmentIds: string[],
  ): Promise<{
    manifest: AttachmentManifestEntry[];
    inlineAttachments: Array<{ name: string; contentType: string; contentBytes: string }>;
  }> {
    if (!attachmentIds.length) return { manifest: [], inlineAttachments: [] };
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.findMany({
        where: { tenantId: ctx.tenantId, id: { in: attachmentIds } },
        select: { id: true, fileName: true, contentType: true, byteSize: true, s3Key: true },
      }),
    );
    if (rows.length !== attachmentIds.length) {
      throw new BadRequestException('One or more attachments could not be found.');
    }
    const manifest: AttachmentManifestEntry[] = [];
    const inlineAttachments: Array<{ name: string; contentType: string; contentBytes: string }> = [];
    const oversized: string[] = [];
    for (const row of rows) {
      if (row.byteSize != null && Number(row.byteSize) > INLINE_ATTACHMENT_MAX_BYTES) {
        oversized.push(row.fileName);
        continue;
      }
      const bytes = await this.engagement.readAttachmentBytes(row.s3Key);
      if (bytes.length > INLINE_ATTACHMENT_MAX_BYTES) {
        oversized.push(row.fileName);
        continue;
      }
      manifest.push({
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        byteSize: bytes.length,
      });
      inlineAttachments.push({
        name: row.fileName,
        contentType: row.contentType,
        contentBytes: bytes.toString('base64'),
      });
    }
    if (oversized.length) {
      throw new BadRequestException(
        `These files are over the 3 MB email limit and cannot be sent: ${oversized.join(', ')}. ` +
          `Remove them or share a link instead.`,
      );
    }
    return { manifest, inlineAttachments };
  }

  /** Re-read attachment bytes at send time from the committed manifest. */
  private async loadManifestBytes(
    ctx: TenantContext,
    manifest: AttachmentManifestEntry[],
  ): Promise<Array<{ name: string; contentType: string; contentBytes: string }> | undefined> {
    if (!manifest.length) return undefined;
    const rows = await this.prisma.withSystem((tx) =>
      tx.engagementAttachment.findMany({
        where: { tenantId: ctx.tenantId, id: { in: manifest.map((m) => m.id) } },
        select: { id: true, fileName: true, contentType: true, s3Key: true },
      }),
    );
    if (rows.length !== manifest.length) {
      throw new Error('An attachment selected for this send no longer exists.');
    }
    const out: Array<{ name: string; contentType: string; contentBytes: string }> = [];
    for (const row of rows) {
      const bytes = await this.engagement.readAttachmentBytes(row.s3Key);
      out.push({
        name: row.fileName,
        contentType: row.contentType,
        contentBytes: bytes.toString('base64'),
      });
    }
    return out;
  }
}

// ── pure helpers (exported for unit tests) ───────────────────────────────────

interface ClaimedDeliveryRow {
  id: string;
  tenant_id: string;
  draft_version_id: string;
  generation_key: string;
  correlation_id: string;
  rendered_subject: string;
  rendered_body: string;
  recipient_envelope_jsonb: unknown;
  attachment_manifest_jsonb: unknown;
  provider: string;
}

interface ClaimedDelivery {
  id: string;
  tenantId: string;
  draftVersionId: string;
  generationKey: string;
  correlationId: string;
  renderedSubject: string;
  renderedBody: string;
  envelope: RecipientEnvelope;
  manifest: AttachmentManifestEntry[];
  provider: string;
}

/**
 * The To/Cc/Bcc envelope for one delivery, taken from the artifact's recipient
 * SNAPSHOT captured at generation time.
 *
 * A group representative carries every member in `groupMembers` → ONE shared
 * email with all of them in To (never one email each). Because the envelope is
 * part of the idempotency key, changing recipients necessarily produces a new
 * delivery identity rather than silently re-addressing an existing one.
 */
export function buildEnvelope(recipientSnapshot: unknown): RecipientEnvelope {
  const r = (recipientSnapshot ?? {}) as Record<string, unknown>;
  const groupMembers = Array.isArray(r.groupMembers) ? r.groupMembers : [];
  const groupTo = groupMembers
    .map((m) => {
      const member = (m ?? {}) as Record<string, unknown>;
      return {
        email: String(member.email ?? '').trim(),
        name: member.name ? String(member.name) : null,
      };
    })
    .filter((m) => m.email);
  const single = String(r.email ?? '').trim();
  const to = groupTo.length
    ? groupTo
    : single
      ? [{ email: single, name: r.name ? String(r.name) : null }]
      : [];
  const clean = (list: unknown): string[] =>
    (Array.isArray(list) ? list : [])
      .map((e) => String(e ?? '').trim())
      .filter(Boolean);
  return { to, cc: clean(r.cc), bcc: clean(r.bcc) };
}

/**
 * sha256(tenant + connection + version + canonical envelope + canonical manifest).
 *
 * Canonical means order-independent and whitespace/case-normalized for addresses,
 * so the same logical delivery always hashes the same way and the unique index
 * can refuse a second copy even under a fresh request key.
 */
export function deliveryIdempotencyKey(input: {
  tenantId: string;
  senderConnectionId: string;
  draftVersionId: string;
  envelope: RecipientEnvelope;
  manifest: AttachmentManifestEntry[];
  testMode: boolean;
}): string {
  const addrs = (list: Array<{ email: string }> | string[]): string[] =>
    list
      .map((e) => (typeof e === 'string' ? e : e.email))
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
      .sort();
  const canonical = JSON.stringify({
    t: input.tenantId,
    c: input.senderConnectionId,
    v: input.draftVersionId,
    to: addrs(input.envelope.to ?? []),
    cc: addrs(input.envelope.cc ?? []),
    bcc: addrs(input.envelope.bcc ?? []),
    a: [...input.manifest.map((m) => `${m.id}:${m.byteSize}`)].sort(),
    test: input.testMode,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Tally deliveries by status. */
export function countByStatus(statuses: OutreachDeliveryStatus[]): Record<string, number> {
  const totals: Record<string, number> = {
    total: statuses.length,
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    held: 0,
  };
  for (const s of statuses) totals[s] = (totals[s] ?? 0) + 1;
  return totals;
}

/**
 * Intent status from its delivery tallies.
 *
 * An 'unknown' delivery keeps the intent OUT of 'complete': the operator must
 * look at it. Nothing is ever reported as a blanket success while an outcome is
 * undetermined (edge cases 27/28).
 */
export function rollUpStatus(
  totals: Record<string, number>,
): 'queued' | 'running' | 'partial' | 'complete' | 'failed' {
  const inFlight = (totals.pending ?? 0) + (totals.sending ?? 0);
  const sent = totals.sent ?? 0;
  const failed = totals.failed ?? 0;
  const unknown = totals.unknown ?? 0;
  const skipped = totals.skipped ?? 0;
  if (inFlight > 0) return sent + failed + unknown > 0 ? 'running' : 'queued';
  if (failed === 0 && unknown === 0 && skipped === 0) return 'complete';
  if (sent === 0 && unknown === 0 && skipped === 0) return 'failed';
  return 'partial';
}

/** v2, v2.1, v3… pass; v1 does not. Prefix-safe, not a string compare. */
export function isPromptSpecV2OrLater(promptSpecVersion: string | null | undefined): boolean {
  if (!promptSpecVersion) return false;
  const match = /^v(\d+)/i.exec(promptSpecVersion.trim());
  if (!match) return false;
  return Number(match[1]) >= 2;
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

/** Sanitized, stable error codes — never a raw provider body. */
function classifyProviderError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b401\b|unauthor/i.test(message)) return 'PROVIDER_UNAUTHORIZED';
  if (/\b403\b|insufficient|scope/i.test(message)) return 'PROVIDER_FORBIDDEN';
  if (/\b429\b|rate/i.test(message)) return 'PROVIDER_RATE_LIMITED';
  if (/\b4\d\d\b/.test(message)) return 'PROVIDER_REJECTED';
  if (/\b5\d\d\b/.test(message)) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

/** Bounded so a malformed provider identifier cannot bloat the row. */
function boundedId(value: string | null): string | null {
  if (!value) return null;
  const clean = String(value).replace(/[\r\n]/g, '').trim();
  return clean ? clean.slice(0, 500) : null;
}

function truncateError(message: string): string {
  return String(message).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal worker context — enough for RLS + own-user provider ownership. */
function workerContext(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    tenantSlug: '',
    userId,
    clerkUserId: '',
    role: 'standard_user',
  } as TenantContext;
}
