import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import { MailboxKnowledgeFlagsService } from './mailbox-knowledge-flags.service.js';
import { MailboxKnowledgeRepository } from './mailbox-knowledge.repository.js';
import type {
  MailboxKnowledgeDrainResult,
  MailboxKnowledgeJobRecord,
  MailboxMessageRecord,
  MailboxRelevanceResult,
} from './mailbox-knowledge.types.js';
import { MailboxNormalizerService } from './mailbox-normalizer.service.js';
import { MailboxRelevanceService } from './mailbox-relevance.service.js';
import {
  MailboxThreadService,
  mailboxEventType,
  mailboxSourceType,
} from './mailbox-thread.service.js';

/**
 * Asynchronous Phase 4 consumer. Provider sync commits mail + its outbox row;
 * this worker later creates immutable KnowledgeEvents. No model or extraction
 * call occurs here—Phase 5/6 consume the event handoff.
 */
@Injectable()
export class MailboxKnowledgeConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailboxKnowledgeConsumer.name);
  private readonly workerId = `${process.env.HOSTNAME ?? 'local'}:${process.pid}:${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly flags: MailboxKnowledgeFlagsService,
    private readonly repository: MailboxKnowledgeRepository,
    private readonly normalizer: MailboxNormalizerService,
    private readonly relevance: MailboxRelevanceService,
    private readonly threads: MailboxThreadService,
    private readonly events: KnowledgeEventService,
  ) {}

  onModuleInit(): void {
    if (!this.flags.enabled()) {
      this.logger.log('Mailbox knowledge ingestion is disabled by feature flags.');
      return;
    }
    this.timer = setInterval(() => {
      void this.drainOnce().catch((error: unknown) => {
        this.logger.error(
          `Mailbox knowledge drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.flags.pollIntervalMs());
    this.timer.unref();
    void this.drainOnce().catch((error: unknown) => {
      this.logger.error(
        `Initial mailbox knowledge drain failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drainOnce(): Promise<MailboxKnowledgeDrainResult> {
    const result: MailboxKnowledgeDrainResult = {
      claimed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    };
    if (!this.flags.enabled() || this.draining) return result;

    this.draining = true;
    try {
      const jobs = await this.repository.claimBatch(this.workerId, this.flags.batchSize());
      result.claimed = jobs.length;
      for (const job of jobs) {
        const outcome = await this.processClaimedJob(job);
        result[outcome] += 1;
      }
      return result;
    } finally {
      this.draining = false;
    }
  }

  private async processClaimedJob(
    job: MailboxKnowledgeJobRecord,
  ): Promise<'succeeded' | 'skipped' | 'failed'> {
    try {
      const message = await this.repository.loadMessage(job.tenantId, job.mailMessageId);
      if (!message) {
        await this.repository.skip(job, null, 'mail message no longer exists');
        return 'skipped';
      }
      if (message.removedAt) {
        await this.repository.skip(
          job,
          null,
          `mail message is removed${message.removedReason ? `: ${message.removedReason}` : ''}`,
        );
        return 'skipped';
      }
      if (message.currentSourceRevision !== job.sourceRevision) {
        await this.repository.skip(
          job,
          null,
          'mail message revision was superseded before processing',
        );
        return 'skipped';
      }
      if (!message.connectionOwnerUserId) {
        await this.repository.skip(
          job,
          null,
          'mailbox owner is unavailable; access scope cannot be derived safely',
        );
        return 'skipped';
      }
      if (!hasAuthoritativeProviderBody(message)) {
        await this.repository.skip(
          job,
          insufficient('provider row contains only a preview; full authoritative body is required'),
          'provider row contains only a preview; full authoritative body is required',
        );
        return 'skipped';
      }

      const normalized = this.normalizer.normalize(message);
      if (!normalized.authoritativeText || !normalized.normalizedText) {
        await this.repository.skip(
          job,
          insufficient('message has no canonical authoritative text'),
          'message has no canonical authoritative text',
          normalized.authoritativeContentHash,
        );
        return 'skipped';
      }

      const relevance = this.relevance.classify(message, normalized);
      if (!relevance.eligible) {
        await this.repository.skip(
          job,
          relevance,
          `relevance gate: ${relevance.category}`,
          normalized.authoritativeContentHash,
        );
        return 'skipped';
      }

      const context = this.threads.buildContext(message, normalized, relevance);
      const occurredAt = occurredAtFor(message);
      const observedAt = message.updatedAt.getTime() >= occurredAt.getTime()
        ? message.updatedAt
        : occurredAt;
      const event = await this.events.append(job.tenantId, {
        sourceType: mailboxSourceType(message.source),
        sourceId: message.externalId ?? message.id,
        sourceVersion: job.sourceRevision,
        sourceContentHash: normalized.authoritativeContentHash,
        eventType: mailboxEventType(message),
        occurredAt,
        observedAt,
        actorRefs: context.actorRefs,
        entityRefs: context.entityRefs,
        clientRefs: context.clientRefs,
        sensitivity: context.sensitivity,
        accessScope: context.accessScope,
        evidenceLocator: context.evidenceLocator,
        metadata: context.metadata,
        originTraceId: job.id,
      });

      await this.repository.complete(
        job,
        event.id,
        normalized.authoritativeContentHash,
        relevance,
      );
      return 'succeeded';
    } catch (error) {
      await this.repository.fail(job, error, this.flags.maxAttempts());
      this.logger.warn(
        `Mailbox knowledge job ${job.id} failed on attempt ${job.attemptCount}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'failed';
    }
  }
}

function occurredAtFor(message: MailboxMessageRecord): Date {
  return message.sentAt ?? message.receivedAt ?? message.createdAt;
}

function insufficient(reason: string): MailboxRelevanceResult {
  return {
    category: 'insufficient_content',
    eligible: false,
    score: 0,
    reasons: [reason],
    signals: {
      clientLinked: false,
      governmentTerms: [],
      relationshipTerms: [],
      automatedSender: false,
      newsletterMarkers: [],
      marketingMarkers: [],
    },
  };
}

/**
 * A provider preview may be useful for UI rendering, but it is not the source
 * body Phase 3 evidence offsets must bind to. Google rows are eligible only
 * when the MIME-derived body differs from Gmail's stored provider snippet (or
 * an explicit future completeness marker says full). Outlook is preview-only
 * today and remains disabled unless a full Graph body is stored explicitly.
 */
export function hasAuthoritativeProviderBody(message: MailboxMessageRecord): boolean {
  const completeness = message.metadata.bodyCompleteness;
  if (completeness === 'full') return true;
  if (completeness === 'preview') return false;

  const rawBody = message.raw?.body;
  if (
    rawBody &&
    typeof rawBody === 'object' &&
    !Array.isArray(rawBody) &&
    typeof rawBody.content === 'string' &&
    rawBody.content.trim().length > 0
  ) {
    return true;
  }

  if (message.source !== 'google') return false;
  const body = bodyProbe(message.bodyText);
  const rawSnippet = message.raw?.snippet;
  if (!body || typeof rawSnippet !== 'string') return false;
  return body !== bodyProbe(rawSnippet);
}

function bodyProbe(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
    : '';
}
