import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildCapabilityText,
  embedAndUpsert,
  type EmbedOutcome,
} from './embedder.js';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embedding-provider.js';

/**
 * Nest-side embeddings facade for on-write code paths in the API container.
 *
 * Two operating modes:
 *   1. **embedCapabilityImmediate**, awaitable, surfaces errors. Use only
 *      when a caller actually needs the embedding to be live before the
 *      response returns (rare; nothing in the current app needs this).
 *   2. **embedCapabilityFireAndForget**, schedules the embed on the next
 *      microtask and swallows errors with a log line. This is the default
 *      for user-facing create/update mutations: an embedding-provider blip
 *      should never cause the user's capability save to 4xx/5xx.
 *
 * On-write hooks live in the sync scripts (bill, LDA) rather than here -
 * those scripts run outside the Nest container and import `embedder.ts`
 * directly. Same provider contract, different process.
 */
@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async embedCapabilityImmediate(capabilityId: string): Promise<EmbedOutcome> {
    // Fire-and-forget on-write embed: runs via setImmediate AFTER the request,
    // so no tenant GUC is set on this connection. client_capabilities is
    // RLS-FORCED, so read the row on the system (bypass) path; we then embed it
    // strictly for ITS OWN tenant (embedAndUpsert below uses bypassRls:false).
    const cap = await this.prisma.withSystem((tx) =>
      tx.clientCapability.findUnique({
        where: { id: capabilityId },
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          name: true,
          type: true,
          description: true,
          justification: true,
          districtNexus: true,
          sector: true,
          serviceBranch: true,
          issueCodes: true,
          tags: true,
        },
      }),
    );
    if (!cap) return 'skipped';
    const text = buildCapabilityText(cap);
    return embedAndUpsert(
      this.prisma,
      {
        tenantId: cap.tenantId,
        clientId: cap.clientId,
        sourceType: 'capability',
        sourceId: cap.id,
        text,
        // The API service runs under the capiro_app DB role; bypassRls=true
        // lets it write embeddings for the capability's tenant even though
        // the on-write call happens inside a per-request connection that
        // may have set a different current_tenant_id. The WITH CHECK still
        // requires tenant_id to match the row we're inserting.
        //
        // Actually we want strict RLS here, set bypassRls=false so the
        // policy enforces that we can only write embeddings for the same
        // tenant whose capability we're embedding. If the request tenant
        // doesn't match, this is a bug we'd rather fail loud.
        bypassRls: false,
      },
      this.embeddingProvider,
    );
  }

  /** Fire-and-forget, schedules on the event loop, never throws to caller.
   *  Use from create/update mutations so a provider outage doesn't fail the
   *  user's write. */
  embedCapabilityFireAndForget(capabilityId: string): void {
    // setImmediate decouples the embed from the request's response cycle.
    setImmediate(() => {
      this.embedCapabilityImmediate(capabilityId).catch((err) => {
        this.logger.warn(
          `embedCapability ${capabilityId} failed: ${(err as Error).message}`,
        );
      });
    });
  }
}
