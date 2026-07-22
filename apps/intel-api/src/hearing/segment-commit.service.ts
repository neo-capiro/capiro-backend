import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import type { FinalSegment, ExtractionResult } from './hearing.types.js';

const CLIENT_RELEVANCE_ENCRYPT_THRESHOLD = 0.3;

/**
 * Commits finalized transcript segments + derived intelligence to Postgres,
 * enforcing the session's recording_policy AT THE STORAGE LAYER (SC5.3) and
 * AES-256-GCM encryption for client-relevant text (SC5.4).
 *
 * recording_policy semantics (enforced here, not in the UI):
 *   - no_storage           -> persist NOTHING (return null; live UI only)
 *   - transcript_only      -> persist transcript (encrypted), never audio
 *   - audio_and_transcript -> persist transcript (encrypted); audio handled
 *                             separately by the audio sink (also gated here)
 *
 * Encryption rule: a segment is client-relevant (encrypt) when it has entity
 * mentions OR clientRelevanceScore >= threshold. Otherwise public hearing text
 * MAY be stored as plaintext for searchability. NEVER both ciphertext+plaintext.
 */
@Injectable()
export class SegmentCommitService {
  private readonly logger = new Logger(SegmentCommitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: HearingCryptoService,
  ) {}

  /** True if this policy permits persisting any audio. */
  audioPersistenceAllowed(recordingPolicy: string): boolean {
    return recordingPolicy === 'audio_and_transcript';
  }

  /**
   * Commit one final segment + its extraction. Idempotent on
   * (sessionId,startMs,endMs) so a Deepgram reconnect can't double-write (SC5.9).
   * Returns the persisted segment id, or null when policy is no_storage.
   */
  async commitFinal(params: {
    tenantId: string;
    sessionId: string;
    recordingPolicy: string;
    segment: FinalSegment;
    extraction: ExtractionResult;
  }): Promise<string | null> {
    const { tenantId, sessionId, recordingPolicy, segment, extraction } = params;

    // SC5.3: no_storage persists nothing.
    if (recordingPolicy === 'no_storage') {
      return null;
    }

    const clientRelevant =
      extraction.entityMentions.length > 0 ||
      (extraction.clientRelevanceScore ?? 0) >= CLIENT_RELEVANCE_ENCRYPT_THRESHOLD;

    // SC5.4: client-relevant text encrypted; public text may be plaintext. Never both.
    const textFields = this.buildTextFields(segment.text, clientRelevant);

    // NOTE: we deliberately use create + P2002-catch here rather than upsert.
    // PrismaService.scopedClient injects `where.tenantId` into every
    // where-bearing op (findUnique/update/delete/UPSERT) to enforce tenant
    // isolation in-query (capiro_app bypasses RLS). On this table the upsert's
    // where is the COMPOUND unique (sessionId,startMs,endMs); the injected
    // sibling tenantId turned it into an extended-where-unique upsert that
    // silently failed to persist any segment (0 rows, no error) — the LegiWatch
    // "hearings don't transcribe" regression. `create` is NOT a where-bearing
    // op, so it is passed through unrewritten. Isolation is preserved: the row
    // carries tenantId, the insert runs under withTenant's app.current_tenant
    // RLS context (WITH CHECK), and sessionId is itself tenant-scoped.
    try {
      const created = await this.prisma.withTenant(tenantId, (tx) =>
        tx.transcriptSegment.create({
          data: {
            sessionId,
            tenantId,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speakerLabel: segment.speakerLabel ?? null,
            resolvedSpeakerId: extraction.resolvedSpeakerId ?? null,
            resolvedSpeakerName: extraction.resolvedSpeakerName ?? null,
            isFinal: true,
            confidence: segment.confidence ?? null,
            source: 'deepgram',
            clientRelevanceScore: extraction.clientRelevanceScore ?? null,
            issueTags: extraction.issueTags,
            ...textFields,
          },
        }),
      );

      await this.persistDerived(
        tenantId,
        sessionId,
        created.id,
        segment.startMs,
        extraction,
        clientRelevant,
      );
      return created.id;
    } catch (err) {
      // Idempotent replay (SC5.9): a Deepgram reconnect can re-deliver the same
      // final. The unique (sessionId,startMs,endMs) makes the second insert a
      // P2002 — treat it as a no-op and return the already-persisted id, without
      // re-running persistDerived (the first final already wrote the derivations).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.withTenant(tenantId, (tx) =>
          tx.transcriptSegment.findFirst({
            where: { sessionId, startMs: segment.startMs, endMs: segment.endMs },
            select: { id: true },
          }),
        );
        return existing?.id ?? null;
      }
      this.logger.error(`commitFinal failed for session ${sessionId}: ${(err as Error).message}`);
      throw err;
    }
  }

  private buildTextFields(text: string, encrypt: boolean) {
    if (encrypt && this.crypto.configured) {
      const enc = this.crypto.encrypt(text);
      return {
        textCiphertext: enc.textCiphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion,
        textPlain: null,
      };
    }
    if (encrypt && !this.crypto.configured) {
      // Fail closed: if we must encrypt but cannot, do NOT store plaintext.
      this.logger.warn('client-relevant segment but encryption unconfigured; storing no text');
      return { textCiphertext: null, iv: null, authTag: null, keyVersion: null, textPlain: null };
    }
    return { textCiphertext: null, iv: null, authTag: null, keyVersion: null, textPlain: text };
  }

  private async persistDerived(
    tenantId: string,
    sessionId: string,
    segmentId: string,
    startMs: number,
    extraction: ExtractionResult,
    clientRelevant: boolean,
  ): Promise<void> {
    const ops: Promise<unknown>[] = [];

    for (const m of extraction.entityMentions) {
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.entityMention.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              entityType: m.entityType,
              entityRef: m.entityRef ?? null,
              entityLabel: m.entityLabel,
              confidence: m.confidence ?? null,
            },
          }),
        ),
      );
    }

    if (extraction.keyQuote) {
      const q = extraction.keyQuote;
      const qText = clientRelevant && this.crypto.configured ? this.crypto.encrypt(q.text) : null;
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.keyQuote.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              startMs,
              confidence: q.confidence ?? null,
              issueTags: q.issueTags,
              textCiphertext: qText?.textCiphertext ?? null,
              iv: qText?.iv ?? null,
              authTag: qText?.authTag ?? null,
              keyVersion: qText?.keyVersion ?? null,
              textPlain: qText ? null : clientRelevant ? null : q.text,
            },
          }),
        ),
      );
    }

    if (extraction.actionItem) {
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.liveActionItem.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              startMs,
              description: extraction.actionItem!.description,
            },
          }),
        ),
      );
    }

    if (extraction.summaryCard) {
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.liveSummaryCard.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              startMs,
              cardType: extraction.summaryCard!.cardType,
              title: extraction.summaryCard!.title,
              body: extraction.summaryCard!.body ?? null,
            },
          }),
        ),
      );
    }

    await Promise.allSettled(ops);
  }
}
