import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { KnowledgeEventRecord, KnowledgeJsonObject } from '../knowledge.types.js';
import { KnowledgeEventRepository } from '../events/knowledge-event.repository.js';
import { KnowledgeAssertionRepository } from '../assertions/knowledge-assertion.repository.js';
import { KnowledgeEpisodeWorkerConfigService } from './knowledge-episode-worker-config.service.js';
import { KnowledgeEpisodeRepository } from './knowledge-episode.repository.js';
import {
  mailboxThreadEpisodeIdentityKey,
  mailboxThreadGroupingKeyFromEvent,
  requireUnambiguousEventScope,
} from './knowledge-episode-identity.js';
import type {
  KnowledgeEpisodeProjectionDrainResult,
  KnowledgeEpisodeProjectionJobRecord,
} from './knowledge-episode.types.js';

/**
 * Phase 7 post-event projection worker. It performs NO new LLM extraction
 * and NO entity resolution: canonical-entity membership is derived only from
 * KnowledgeAssertion rows that Phase 6 already resolved and wrote against
 * this event (subjectId/objectId already bound to a `canonical_entity`);
 * this worker never calls the Phase 5 resolver itself.
 *
 * Grouping identity is derived only from the immutable KnowledgeEvent
 * (evidenceLocator.connectionId/providerThreadId, sensitivity, accessScope,
 * clientRefs) — never from a later, possibly-changed message/thread CRM
 * association — so an episode's security partition is fixed at the moment
 * its founding event was written and can never silently widen afterward.
 */
@Injectable()
export class KnowledgeEpisodeProjectionConsumer {
  private readonly logger = new Logger(KnowledgeEpisodeProjectionConsumer.name);
  private readonly workerId = `${process.env.HOSTNAME ?? 'local'}:${process.pid}:${randomUUID()}`;
  private draining = false;

  constructor(
    private readonly config: KnowledgeEpisodeWorkerConfigService,
    private readonly repository: KnowledgeEpisodeRepository,
    private readonly events: KnowledgeEventRepository,
    private readonly assertions: KnowledgeAssertionRepository,
  ) {}

  async drainOnce(): Promise<KnowledgeEpisodeProjectionDrainResult> {
    const result: KnowledgeEpisodeProjectionDrainResult = {
      claimed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    };
    if (this.draining) return result;

    this.draining = true;
    try {
      const jobs = await this.repository.claimBatch(this.workerId, this.config.batchSize());
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
    job: KnowledgeEpisodeProjectionJobRecord,
  ): Promise<'succeeded' | 'skipped' | 'failed'> {
    try {
      const event = await this.events.findById(job.tenantId, job.eventId);
      if (!event) return this.skip(job, 'KnowledgeEvent no longer exists');
      if (event.tenantId !== job.tenantId) throw new Error('KnowledgeEventTenantMismatch');
      if (event.status !== 'active') return this.skip(job, 'KnowledgeEvent is no longer active');

      requireUnambiguousEventScope(event);

      const groupingKey = mailboxThreadGroupingKeyFromEvent(event);
      if (!groupingKey) {
        return this.skip(
          job,
          'KnowledgeEvent evidenceLocator has no connectionId/providerThreadId; mailbox_thread_v1 cannot group it',
        );
      }
      const identityKey = mailboxThreadEpisodeIdentityKey(groupingKey);

      const episode = await this.repository.findOrCreateEpisode({
        tenantId: job.tenantId,
        strategy: 'mailbox_thread_v1',
        identityKey,
        sensitivity: event.sensitivity,
        accessScope: event.accessScope,
        clientRefs: event.clientRefs,
        groupingKey: groupingKey as unknown as KnowledgeJsonObject,
        occurredAt: event.occurredAt,
      });

      // Fail closed rather than silently reusing a scope-mismatched episode
      // row: even though the identity key is derived FROM sensitivity/
      // accessScope (so a mismatch should be structurally impossible), this
      // is the last line of defense against ever widening access.
      if (episode.sensitivity !== event.sensitivity) {
        throw new Error('EpisodeSensitivityMismatch');
      }

      await this.repository.addEventMembership({
        tenantId: job.tenantId,
        episodeId: episode.id,
        eventId: event.id,
        occurredAt: event.occurredAt,
      });

      await this.projectAssertionAndEntityMembership(job.tenantId, episode.id, event);

      const completed = await this.repository.complete(job, episode.id);
      if (completed === false) return 'skipped';
      return 'succeeded';
    } catch (error) {
      const failed = await this.repository.fail(job, error, this.config.maxAttempts());
      if (failed === false) return 'skipped';
      this.logger.warn(
        `Knowledge episode projection job failed on attempt ${job.attemptCount}: ${
          error instanceof Error ? error.name : 'UnknownError'
        }`,
      );
      return 'failed';
    }
  }

  /**
   * Assertion and canonical-entity membership are derived exclusively from
   * assertions that already originate from this event — no new assertion,
   * no new resolution, no model call. A canonical entity is added to the
   * episode only when an already-resolved assertion's subjectId/objectId
   * names it, which is exactly the "reuse Phase 5 canonical IDs, never
   * literal-name match" invariant.
   */
  private async projectAssertionAndEntityMembership(
    tenantId: string,
    episodeId: string,
    event: KnowledgeEventRecord,
  ): Promise<void> {
    const originAssertions = await this.assertions.findByOriginEvent(tenantId, event.id);
    for (const assertion of originAssertions) {
      await this.repository.addAssertionMembership({
        tenantId,
        episodeId,
        assertionId: assertion.id,
        originEventId: event.id,
      });

      if (assertion.subjectType === 'canonical_entity') {
        await this.repository.addEntityMembership({
          tenantId,
          episodeId,
          canonicalEntityId: assertion.subjectId,
        });
      }
      if (assertion.objectType === 'canonical_entity' && assertion.objectId) {
        await this.repository.addEntityMembership({
          tenantId,
          episodeId,
          canonicalEntityId: assertion.objectId,
        });
      }
    }
  }

  private async skip(
    job: KnowledgeEpisodeProjectionJobRecord,
    reason: string,
  ): Promise<'skipped'> {
    await this.repository.skip(job, reason);
    return 'skipped';
  }
}
