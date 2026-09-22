import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { PublicTranscriptSinkPort } from './ffmpeg-deepgram-capture.runtime.js';
import { StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
import { STATE_CAPTURE_LINK_ONLY } from '../state-capture-policy.js';

@Injectable()
export class PublicHearingTranscriptStore implements PublicTranscriptSinkPort {
  private readonly pendingGaps = new Map<string, boolean>();

  constructor(private readonly prisma: PrismaService) {}

  private async assertFederalCaptureOwned(
    tx: Prisma.TransactionClient,
    input: {
      captureId: string;
      hearingId: string;
      lease: { ownerId: string; fencingToken: number };
    },
  ): Promise<void> {
    const owned = await tx.$queryRawUnsafe<
      Array<{ id: string; federalHearingId: string | null }>
    >(
      `SELECT c.id,f.id AS "federalHearingId"
       FROM public_hearing_capture c
       LEFT JOIN federal_committee_hearing f ON f.id=c.hearing_id
       WHERE c.id=$1 AND c.hearing_id=$2
         AND c.worker_lease_owner=$3 AND c.fencing_token=$4
         AND c.lease_expires_at > clock_timestamp()
       FOR UPDATE OF c`,
      input.captureId,
      input.hearingId,
      input.lease.ownerId,
      input.lease.fencingToken,
    );
    const capture = owned[0];
    if (!capture) throw new StaleCaptureFencingTokenError();
    // A valid lease is insufficient: transcript persistence is released only
    // for a positively matched canonical federal hearing. State and orphaned
    // captures both fail closed before any segment/gap write.
    if (!capture.federalHearingId) throw new Error(STATE_CAPTURE_LINK_ONLY);
  }

  async appendFinal(input: Parameters<PublicTranscriptSinkPort['appendFinal']>[0]): Promise<void> {
    const hasGap = this.pendingGaps.get(input.captureId) === true;
    const count = await this.prisma.$transaction(async (tx) => {
      await this.assertFederalCaptureOwned(tx, input);
      const inserted = await tx.$executeRawUnsafe(
        `INSERT INTO public_hearing_transcript_segment
       (id,capture_id,sequence,start_ms,end_ms,text,speaker_label,transcription_confidence,is_final,has_gap_before)
       VALUES (gen_random_uuid(),$1,(SELECT COALESCE(MAX(sequence),0)+1 FROM public_hearing_transcript_segment WHERE capture_id=$1),$2,$3,$4,$5,$6,true,$7)
       ON CONFLICT (capture_id,start_ms,end_ms) DO NOTHING`,
        input.captureId,
        input.segment.startMs,
        input.segment.endMs,
        input.segment.text,
        input.segment.speakerLabel ?? null,
        input.segment.confidence ?? null,
        hasGap,
      );
      await tx.$executeRawUnsafe(
        `UPDATE public_hearing_capture SET captured_ms=GREATEST(captured_ms,$2),
         captured_seconds=GREATEST(captured_seconds,$2::int / 1000) WHERE id=$1`,
        input.captureId,
        input.segment.endMs,
      );
      return inserted;
    });
    if (count > 0 && hasGap) this.pendingGaps.delete(input.captureId);
  }

  async appendGap(input: Parameters<PublicTranscriptSinkPort['appendGap']>[0]): Promise<void> {
    const durationSeconds = Math.max(0, Math.ceil((input.gap.endMs - input.gap.startMs) / 1000));
    const count = await this.prisma.$transaction(async (tx) => {
      await this.assertFederalCaptureOwned(tx, input);
      return tx.$executeRawUnsafe(
        `UPDATE public_hearing_capture SET transcript_gap_seconds=transcript_gap_seconds+$2,
       gaps=gaps || $3::jsonb, captured_ms=GREATEST(captured_ms,$6),
       captured_seconds=GREATEST(captured_seconds,$6::int / 1000), updated_at=now()
       WHERE id=$1 AND hearing_id=$7 AND worker_lease_owner=$4 AND fencing_token=$5
         AND lease_expires_at > clock_timestamp()`,
        input.captureId,
        durationSeconds,
        JSON.stringify([input.gap]),
        input.lease.ownerId,
        input.lease.fencingToken,
        input.gap.endMs,
        input.hearingId,
      );
    });
    if (count === 0) throw new StaleCaptureFencingTokenError();
    this.pendingGaps.set(input.captureId, true);
  }
}
