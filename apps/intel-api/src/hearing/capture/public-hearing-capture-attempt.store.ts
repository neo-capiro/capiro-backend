import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface CaptureAttemptInput {
  captureId:string; startedAt?:Date; endedAt?:Date; workerLeaseOwner?:string;
  deepgramSessionRef?:string; outcome?:string; failureCode?:string; failureDetail?:string;
}
export interface CaptureAttemptRecord extends CaptureAttemptInput { id:string; attemptNumber:number; createdAt:Date }

@Injectable()
export class PublicHearingCaptureAttemptStore {
  constructor(private readonly prisma: PrismaService) {}
  async recordAttempt(input: CaptureAttemptInput): Promise<CaptureAttemptRecord> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureAttemptRecord[]>(
      `INSERT INTO public_hearing_capture_attempt
       (id,capture_id,attempt_number,started_at,ended_at,worker_lease_owner,deepgram_session_ref,outcome,failure_code,failure_detail)
       VALUES (gen_random_uuid(),$1,(SELECT COALESCE(MAX(attempt_number),0)+1 FROM public_hearing_capture_attempt WHERE capture_id=$1),$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, capture_id AS "captureId", attempt_number AS "attemptNumber", started_at AS "startedAt",
       ended_at AS "endedAt", worker_lease_owner AS "workerLeaseOwner", deepgram_session_ref AS "deepgramSessionRef",
       outcome, failure_code AS "failureCode", failure_detail AS "failureDetail", created_at AS "createdAt"`,
      input.captureId,input.startedAt ?? null,input.endedAt ?? null,input.workerLeaseOwner ?? null,
      input.deepgramSessionRef ?? null,input.outcome ?? null,input.failureCode ?? null,input.failureDetail ?? null);
    if (!rows[0]) throw new Error('capture attempt insert returned no row');
    return rows[0];
  }
}
