import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { PublicTranscriptSinkPort } from './ffmpeg-deepgram-capture.runtime.js';
import { StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';

@Injectable()
export class PublicHearingTranscriptStore implements PublicTranscriptSinkPort {
  // One fenced worker owns a capture at a time. This flag only bridges appendGap
  // to the immediately following appendFinal within that worker process; gaps are
  // also durably appended to public_hearing_capture.gaps below.
  private readonly pendingGaps = new Map<string, boolean>();
  constructor(private readonly prisma: PrismaService) {}

  async appendFinal(input: Parameters<PublicTranscriptSinkPort['appendFinal']>[0]): Promise<void> {
    const hasGap = this.pendingGaps.get(input.captureId) === true;
    const count = await this.prisma.$transaction(async (tx) => {
      // Lock the owning capture before both transcript insertion and progress.
      // A stale worker's delayed final events must not outlive its lease.
      const owned = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM public_hearing_capture
         WHERE id=$1 AND worker_lease_owner=$2 AND fencing_token=$3
           AND lease_expires_at > clock_timestamp() FOR UPDATE`,
        input.captureId, input.lease.ownerId, input.lease.fencingToken,
      );
      if (!owned[0]) throw new StaleCaptureFencingTokenError();
      const inserted = await tx.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
       (id,capture_id,sequence,start_ms,end_ms,text,speaker_label,transcription_confidence,is_final,has_gap_before)
       VALUES (gen_random_uuid(),$1,(SELECT COALESCE(MAX(sequence),0)+1 FROM public_hearing_transcript_segment WHERE capture_id=$1),$2,$3,$4,$5,$6,true,$7)
       ON CONFLICT (capture_id,start_ms,end_ms) DO NOTHING`, input.captureId,input.segment.startMs,
      input.segment.endMs,input.segment.text,input.segment.speakerLabel ?? null,input.segment.confidence ?? null,hasGap);
      // Checkpoint without changing the coordinator's optimistic state version.
      // A crashed task can resume after already-persisted transcript timestamps.
      await tx.$executeRawUnsafe(
        `UPDATE public_hearing_capture SET captured_ms=GREATEST(captured_ms,$2),
         captured_seconds=GREATEST(captured_seconds,$2::int / 1000) WHERE id=$1`,
        input.captureId, input.segment.endMs,
      );
      return inserted;
    });
    if (count > 0 && hasGap) this.pendingGaps.delete(input.captureId);
  }

  async appendGap(input: Parameters<PublicTranscriptSinkPort['appendGap']>[0]): Promise<void> {
    void input.hearingId;
    const durationSeconds = Math.max(0, Math.ceil((input.gap.endMs-input.gap.startMs)/1000));
    const count = await this.prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture SET transcript_gap_seconds=transcript_gap_seconds+$2,
       gaps=gaps || $3::jsonb, captured_ms=GREATEST(captured_ms,$6),
       captured_seconds=GREATEST(captured_seconds,$6::int / 1000), updated_at=now()
       WHERE id=$1 AND worker_lease_owner=$4 AND fencing_token=$5
         AND lease_expires_at > clock_timestamp()`,
      input.captureId,durationSeconds,JSON.stringify([input.gap]),
      input.lease.ownerId,input.lease.fencingToken,input.gap.endMs);
    if (count === 0) throw new StaleCaptureFencingTokenError();
    this.pendingGaps.set(input.captureId,true);
  }
}
