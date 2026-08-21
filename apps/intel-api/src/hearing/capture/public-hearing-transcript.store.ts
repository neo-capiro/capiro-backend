import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { PublicTranscriptSinkPort } from './ffmpeg-deepgram-capture.runtime.js';
import type { CaptureGap } from './public-hearing-capture-state.js';

@Injectable()
export class PublicHearingTranscriptStore implements PublicTranscriptSinkPort {
  // One fenced worker owns a capture at a time. This flag only bridges appendGap
  // to the immediately following appendFinal within that worker process; gaps are
  // also durably appended to public_hearing_capture.gaps below.
  private readonly pendingGaps = new Map<string, boolean>();
  constructor(private readonly prisma: PrismaService) {}

  async appendFinal(input: Parameters<PublicTranscriptSinkPort['appendFinal']>[0]): Promise<void> {
    const hasGap = this.pendingGaps.get(input.captureId) === true;
    const count = await this.prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_transcript_segment
       (id,capture_id,sequence,start_ms,end_ms,text,speaker_label,transcription_confidence,is_final,has_gap_before)
       VALUES (gen_random_uuid(),$1,(SELECT COALESCE(MAX(sequence),0)+1 FROM public_hearing_transcript_segment WHERE capture_id=$1),$2,$3,$4,$5,$6,true,$7)
       ON CONFLICT (capture_id,start_ms,end_ms) DO NOTHING`, input.captureId,input.segment.startMs,
      input.segment.endMs,input.segment.text,input.segment.speakerLabel ?? null,input.segment.confidence ?? null,hasGap);
    if (count > 0 && hasGap) this.pendingGaps.delete(input.captureId);
  }

  async appendGap(input: { captureId:string; hearingId:string; gap:CaptureGap }): Promise<void> {
    void input.hearingId;
    const durationSeconds = Math.max(0, Math.ceil((input.gap.endMs-input.gap.startMs)/1000));
    await this.prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture SET transcript_gap_seconds=transcript_gap_seconds+$2,
       gaps=gaps || $3::jsonb, updated_at=now() WHERE id=$1`,
      input.captureId,durationSeconds,JSON.stringify([input.gap]));
    this.pendingGaps.set(input.captureId,true);
  }
}
