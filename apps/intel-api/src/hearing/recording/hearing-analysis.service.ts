import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SegmentCommitService } from '../segment-commit.service.js';
import { HearingCryptoService } from '../hearing-crypto.service.js';
import { HearingSessionService } from '../hearing-session.service.js';
import { OrchestratorClient } from '../orchestrator.client.js';

/** Persisted final segments are the durable queue. No interim or copied prose. */
@Injectable()
export class HearingAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: HearingCryptoService,
    private readonly commit: SegmentCommitService,
    private readonly orchestrator: OrchestratorClient,
  ) {}

  async runOne(segmentId?: string) {
    const token = randomUUID();
    const row = await this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; tenant_id: string }>>`
        SELECT t.id,t.tenant_id FROM intel_transcript_segment t
        JOIN intel_live_hearing_session s ON s.id=t.session_id AND s.tenant_id=t.tenant_id
        WHERE t.is_final AND s.recording_policy <> 'no_storage' AND t.analysis_actor IS NOT NULL
          AND (${segmentId ?? null}::text IS NULL OR t.id=${segmentId ?? null})
          AND (t.analysis_next_attempt IS NULL OR t.analysis_next_attempt<=now())
          AND (t.analysis_state='pending' OR (t.analysis_state='processing' AND t.analysis_lease_until<now()))
        ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return null;
      return tx.transcriptSegment.update({
        where: { id: rows[0].id, tenantId: rows[0].tenant_id },
        data: {
          analysisState: 'processing',
          analysisToken: token,
          analysisLeaseUntil: new Date(Date.now() + 60_000),
          analysisAttempts: { increment: 1 },
        },
        include: { session: true },
      });
    });
    if (!row) return false;
    try {
      const permission = await this.prisma.withTenant(row.tenantId, (tx) =>
        tx.hearingMediaPermission.count({
          where: {
            tenantId: row.tenantId,
            hearingId: row.session.hearingId,
            sourceUrl: row.session.sourceUrl ?? '',
            revokedAt: null,
            expiresAt: { gt: new Date() },
            operations: { has: 'analysis' },
          },
        }),
      );
      if (!permission) throw new Error('Source analysis permission unavailable');
      const event = row.session.hearingId
        ? await this.prisma.$queryRaw<
            Array<{ jurisdiction: string | null; legislativeSession: string | null }>
          >`
        SELECT geographic_jurisdiction AS jurisdiction,legislative_session AS "legislativeSession" FROM committee_hearing WHERE id=${row.session.hearingId} AND visibility='public'`
        : [];
      const text =
        row.textCiphertext && row.iv && row.authTag
          ? this.crypto.decrypt({
              textCiphertext: row.textCiphertext,
              iv: row.iv,
              authTag: row.authTag,
            })
          : row.textPlain;
      if (!text) throw new Error('Persisted transcript text is unavailable');
      const segment = {
        startMs: row.startMs,
        endMs: row.endMs,
        text,
        speakerLabel: row.speakerLabel ?? undefined,
        confidence: row.confidence ?? undefined,
      };
      const extraction = await this.orchestrator.extract({
        tenantId: row.tenantId,
        sessionId: row.sessionId,
        clerkUserId: row.analysisActor!,
        segment,
        requireSuccess: true,
        sessionContext: {
          clientId: row.session.clientId,
          hearingId: row.session.hearingId,
          committeeId: row.session.committeeId,
          billIds: row.session.billIds,
          issueIds: row.session.issueIds,
          agencyIds: row.session.agencyIds,
          programElementIds: row.session.programElementIds,
          jurisdiction: event[0]?.jurisdiction ?? null,
          legislativeSession: event[0]?.legislativeSession ?? null,
        },
      });
      await this.commit.enrichDurable({
        tenantId: row.tenantId,
        sessionId: row.sessionId,
        segmentId: row.id,
        token,
        segment,
        extraction,
        forceEncrypt: HearingSessionService.isSensitiveSession(row.session),
      });
    } catch {
      await this.prisma.withSystem((tx) =>
        tx.transcriptSegment.updateMany({
          where: {
            tenantId: row.tenantId,
            id: row.id,
            analysisToken: token,
            analysisState: 'processing',
          },
          data: {
            analysisState: row.analysisAttempts >= 5 ? 'failed' : 'pending',
            analysisToken: null,
            analysisLeaseUntil: null,
            analysisNextAttempt: new Date(
              Date.now() + Math.min(3600_000, 30_000 * 2 ** row.analysisAttempts),
            ),
          },
        }),
      );
    }
    await this.refreshRecording(row.tenantId, row.sessionId);
    return true;
  }

  async refreshRecording(tenantId: string, sessionId: string) {
    await this.prisma.withSystem(async (tx) => {
      const unfinished = await tx.transcriptSegment.count({
        where: { tenantId, sessionId, analysisState: { in: ['pending', 'processing'] } },
      });
      const failed = await tx.transcriptSegment.count({
        where: { tenantId, sessionId, analysisState: 'failed' },
      });
      await tx.hearingRecording.updateMany({
        where: { tenantId, sessionId },
        data: { analysisState: unfinished ? 'pending' : failed ? 'partial' : 'ready' },
      });
    });
  }
}
