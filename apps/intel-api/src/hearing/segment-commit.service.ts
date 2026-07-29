import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import type { FinalSegment, ExtractionResult } from './hearing.types.js';

const CLIENT_RELEVANCE_ENCRYPT_THRESHOLD = 0.3;

export interface RawSegmentCommitResult {
  id: string | null;
  created: boolean;
}

/**
 * Commits finalized transcript segments + derived intelligence to Postgres,
 * enforcing the session's recording_policy AT THE STORAGE LAYER (SC5.3) and
 * AES-256-GCM encryption for sensitive text (SC5.4).
 *
 * recording_policy semantics (enforced here, not in the UI):
 *   - no_storage           -> persist NOTHING (return null; live UI only)
 *   - transcript_only      -> persist transcript (encrypted when sensitive)
 *   - audio_and_transcript -> accepted on the wire for older clients but
 *                             normalized to transcript_only at create time;
 *                             there is no audio sink, so nothing else changes
 *
 * Raw transcript persistence is intentionally separate from Meri enrichment:
 * the live transcript is no longer held behind an 8-second model call, and final
 * segments retain their arrival order. Sensitive/private sessions force
 * encryption before any classifier result exists. A later deterministic or AI
 * relevance result can only make storage more restrictive via
 * `protectSegmentText`; it can never downgrade encrypted text to plaintext.
 *
 * KeyQuote, EntityMention, LiveActionItem and LiveSummaryCard ALL have encrypted
 * text columns as of 20260803040000_hearing_derived_encrypted_text, so a sensitive
 * session's derived prose is encrypted and persisted.
 *
 * It used to be DISCARDED — those three tables were plaintext-only, so the
 * fail-closed choice was to store nothing and let the live browser render the cards
 * over its scoped socket. The cost only became visible in the recap: because
 * `isSensitiveSession()` is true for ANY client-linked session, essentially every
 * hearing worth recapping lost its entities, action items and stance cards, and the
 * post-hearing brief fell back to bare transcript fragments. Measured 2026-07-29 on
 * a 62-minute Senate hearing: ~111 segments generated mentions and cards, none were
 * stored.
 *
 * Fail-closed still holds. `buildTextFields` stores NEITHER plaintext nor ciphertext
 * when encryption is required but unconfigured, so a missing key cannot leak — the
 * row simply reads back as '[encrypted]'. Category-ish columns (entityType,
 * entityRef, cardType) stay plaintext deliberately: they are not free text, they
 * keep the rows queryable, and the supporters/opponents split matches on cardType.
 */
@Injectable()
export class SegmentCommitService {
  private readonly logger = new Logger(SegmentCommitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: HearingCryptoService,
  ) {}

  audioPersistenceAllowed(recordingPolicy: string): boolean {
    return recordingPolicy === 'audio_and_transcript';
  }

  async maxEndMs(tenantId: string, sessionId: string): Promise<number> {
    const agg = await this.prisma.withTenant(tenantId, (tx) =>
      tx.transcriptSegment.aggregate({
        where: { tenantId, sessionId, isFinal: true },
        _max: { endMs: true },
      }),
    );
    return agg._max.endMs ?? 0;
  }

  /** Persist and return the raw final immediately, before any model call. */
  async commitRawFinal(params: {
    tenantId: string;
    sessionId: string;
    recordingPolicy: string;
    segment: FinalSegment;
    forceEncrypt: boolean;
  }): Promise<RawSegmentCommitResult> {
    const { tenantId, sessionId, recordingPolicy, segment, forceEncrypt } = params;
    if (recordingPolicy === 'no_storage') return { id: null, created: false };

    const textFields = this.buildTextFields(segment.text, forceEncrypt);
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
            resolvedSpeakerId: null,
            resolvedSpeakerName: null,
            isFinal: true,
            confidence: segment.confidence ?? null,
            source: 'deepgram',
            clientRelevanceScore: null,
            issueTags: [],
            ...textFields,
          },
        }),
      );
      return { id: created.id, created: true };
    } catch (err) {
      // Idempotent replay (SC5.9): a duplicate or replayed final can re-deliver
      // the same segment. The unique (sessionId,startMs,endMs) makes the second
      // insert a P2002 — treat it as a no-op and return the already-persisted id
      // with created=false, so the caller does not re-run enrichment over it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.withTenant(tenantId, (tx) =>
          tx.transcriptSegment.findFirst({
            where: { tenantId, sessionId, startMs: segment.startMs, endMs: segment.endMs },
            select: { id: true },
          }),
        );
        return { id: existing?.id ?? null, created: false };
      }
      this.logger.error(
        `commitRawFinal failed for session ${sessionId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /** Apply asynchronous model enrichment to an already-durable transcript row. */
  async enrichFinal(params: {
    tenantId: string;
    sessionId: string;
    segmentId: string;
    segment: FinalSegment;
    extraction: ExtractionResult;
    /** True for private or explicitly client/matter-linked sessions. */
    forceEncrypt?: boolean;
  }): Promise<void> {
    const { tenantId, sessionId, segmentId, segment, extraction } = params;
    const clientRelevant =
      extraction.entityMentions.length > 0 ||
      (extraction.clientRelevanceScore ?? 0) >= CLIENT_RELEVANCE_ENCRYPT_THRESHOLD;
    const sensitive = params.forceEncrypt === true || clientRelevant;

    if (sensitive) await this.protectSegmentText(tenantId, sessionId, segmentId);

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.transcriptSegment.updateMany({
        where: { id: segmentId, tenantId, sessionId },
        data: {
          resolvedSpeakerId: extraction.resolvedSpeakerId ?? null,
          // A resolved human name is plaintext on TranscriptSegment. Do not write
          // it for a sensitive session until that field has encrypted storage.
          resolvedSpeakerName: sensitive ? null : (extraction.resolvedSpeakerName ?? null),
          clientRelevanceScore: extraction.clientRelevanceScore ?? null,
          issueTags: extraction.issueTags,
        },
      }),
    );

    await this.persistDerived(
      tenantId,
      sessionId,
      segmentId,
      segment.startMs,
      extraction,
      sensitive,
    );
  }

  /**
   * Upgrade a plaintext segment to encrypted storage. If encryption is required
   * but unavailable, fail closed by removing plaintext instead of retaining
   * sensitive content in the clear.
   */
  async protectSegmentText(tenantId: string, sessionId: string, segmentId: string): Promise<void> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.transcriptSegment.findFirst({
        where: { id: segmentId, tenantId, sessionId },
        select: {
          textPlain: true,
          textCiphertext: true,
          iv: true,
          authTag: true,
          keyVersion: true,
        },
      }),
    );
    if (!row || row.textCiphertext || row.textPlain == null) return;

    const protectedFields = this.buildTextFields(row.textPlain, true);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.transcriptSegment.updateMany({
        where: { id: segmentId, tenantId, sessionId, textPlain: row.textPlain },
        data: protectedFields,
      }),
    );
  }

  /** Compatibility entry point retained for existing callers and tests. */
  async commitFinal(params: {
    tenantId: string;
    sessionId: string;
    recordingPolicy: string;
    segment: FinalSegment;
    extraction: ExtractionResult;
  }): Promise<string | null> {
    const clientRelevant =
      params.extraction.entityMentions.length > 0 ||
      (params.extraction.clientRelevanceScore ?? 0) >= CLIENT_RELEVANCE_ENCRYPT_THRESHOLD;
    const raw = await this.commitRawFinal({
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      recordingPolicy: params.recordingPolicy,
      segment: params.segment,
      forceEncrypt: clientRelevant,
    });
    if (raw.id && raw.created) {
      await this.enrichFinal({
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        segmentId: raw.id,
        segment: params.segment,
        extraction: params.extraction,
        forceEncrypt: clientRelevant,
      });
    }
    return raw.id;
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
    // Fail closed: if we must encrypt but cannot, do NOT store plaintext.
    if (encrypt && !this.crypto.configured) {
      this.logger.error(
        'sensitive hearing segment but encryption is unconfigured; storing no text',
      );
      return {
        textCiphertext: null,
        iv: null,
        authTag: null,
        keyVersion: null,
        textPlain: null,
      };
    }
    return {
      textCiphertext: null,
      iv: null,
      authTag: null,
      keyVersion: null,
      textPlain: text,
    };
  }

  private async persistDerived(
    tenantId: string,
    sessionId: string,
    segmentId: string,
    startMs: number,
    extraction: ExtractionResult,
    sensitive: boolean,
  ): Promise<void> {
    const ops: Promise<unknown>[] = [];

    // These three tables now carry encrypted text columns (migration
    // 20260803040000_hearing_derived_encrypted_text), so a sensitive session's
    // derived prose is ENCRYPTED AND PERSISTED rather than discarded.
    //
    // Previously it was dropped on the floor: the live browser still received the
    // cards over its scoped socket, but nothing was stored, so every post-hearing
    // recap for a client-linked session lost its entities, action items and stance
    // cards. Measured on 2026-07-29: ~111 segments logged mentions and cards, all
    // generated, none stored, and the recap degraded to raw transcript fragments.
    //
    // Fail-closed is preserved end to end. `buildTextFields` stores NOTHING when
    // encryption is required but unconfigured, so a missing key still cannot leak
    // plaintext — it just yields a row with neither plaintext nor ciphertext, which
    // reads back as '[encrypted]' rather than as the analyst's words.
    for (const m of extraction.entityMentions) {
      const label = this.buildTextFields(m.entityLabel, sensitive);
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.entityMention.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              // entityType and entityRef are a category and a canonical id, not
              // free text, so they stay plaintext and remain queryable.
              entityType: m.entityType,
              entityRef: m.entityRef ?? null,
              entityLabel: label.textPlain,
              textCiphertext: label.textCiphertext,
              iv: label.iv,
              authTag: label.authTag,
              keyVersion: label.keyVersion,
              confidence: m.confidence ?? null,
            },
          }),
        ),
      );
    }

    // Bind to a const before the closure: TypeScript discards a property
    // narrowing inside a callback, so `extraction.actionItem.description` read
    // as possibly-undefined even under the `if`.
    const actionItem = extraction.actionItem;
    if (actionItem) {
      const desc = this.buildTextFields(actionItem.description, sensitive);
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.liveActionItem.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              startMs,
              description: desc.textPlain,
              textCiphertext: desc.textCiphertext,
              iv: desc.iv,
              authTag: desc.authTag,
              keyVersion: desc.keyVersion,
            },
          }),
        ),
      );
    }

    const summaryCard = extraction.summaryCard;
    if (summaryCard) {
      // Two independent payloads: title and body are separate prose fields.
      const title = this.buildTextFields(summaryCard.title, sensitive);
      const body = summaryCard.body ? this.buildTextFields(summaryCard.body, sensitive) : null;
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.liveSummaryCard.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              startMs,
              // cardType stays plaintext — the supporters/opponents split matches
              // on it, so encrypting it would break that read for exactly the
              // sessions this change is meant to fix.
              cardType: summaryCard.cardType,
              title: title.textPlain,
              titleCiphertext: title.textCiphertext,
              titleIv: title.iv,
              titleAuthTag: title.authTag,
              titleKeyVersion: title.keyVersion,
              body: body?.textPlain ?? null,
              bodyCiphertext: body?.textCiphertext ?? null,
              bodyIv: body?.iv ?? null,
              bodyAuthTag: body?.authTag ?? null,
              bodyKeyVersion: body?.keyVersion ?? null,
            },
          }),
        ),
      );
    }

    if (extraction.keyQuote) {
      const q = extraction.keyQuote;
      const qText = sensitive && this.crypto.configured ? this.crypto.encrypt(q.text) : null;
      ops.push(
        this.prisma.withTenant(tenantId, (tx) =>
          tx.keyQuote.create({
            data: {
              sessionId,
              tenantId,
              segmentId,
              startMs,
              // Speaker names also remain plaintext on KeyQuote. Omit them for
              // sensitive sessions until that column has encrypted storage.
              speakerName: null,
              confidence: q.confidence ?? null,
              issueTags: q.issueTags,
              textCiphertext: qText?.textCiphertext ?? null,
              iv: qText?.iv ?? null,
              authTag: qText?.authTag ?? null,
              keyVersion: qText?.keyVersion ?? null,
              textPlain: qText ? null : sensitive ? null : q.text,
            },
          }),
        ),
      );
    }

    const results = await Promise.allSettled(ops);
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length) {
      this.logger.warn(
        `persistDerived session=${sessionId} segment=${segmentId} failures=${failures.length}`,
      );
    }
  }
}
