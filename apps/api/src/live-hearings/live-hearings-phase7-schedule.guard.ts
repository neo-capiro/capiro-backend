import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface StrictScheduleAssessment {
  allowed: boolean;
  state: 'READY' | 'PREFLIGHT_REQUIRED' | 'BROWSER_ONLY' | 'LICENSE_REQUIRED' | 'BLOCKED';
  reasonCode: string;
  message: string;
}

/**
 * Fail-closed request-boundary policy for unattended Phase 7 scheduling.
 *
 * Phase 3 discovery deliberately records unknown embeds as REVIEW_REQUIRED. A
 * REVIEW_REQUIRED candidate may be accepted as demand pending worker preflight,
 * but BROWSER_CAPTURE_ONLY / LICENSE_REQUIRED / BLOCKED are terminal policy
 * ceilings even if their resolution_state happens to say WAITING_FOR_STREAM.
 * Resolution state can never override capture policy.
 */
@Injectable()
export class LiveHearingsPhase7ScheduleGuard {
  constructor(private readonly prisma: PrismaService) {}

  async assertSchedulable(hearingId: string): Promise<StrictScheduleAssessment> {
    const hearing = await this.prisma.committeeHearing.findUnique({
      where: { id: hearingId },
      select: { id: true, eventStatus: true, visibility: true },
    });
    if (!hearing) throw new NotFoundException(`hearing ${hearingId} not found`);
    const candidates = await this.prisma.hearingStreamCandidate.findMany({
      where: { hearingId },
      orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
      select: { capturePolicy: true, resolutionState: true },
    });
    const assessment = assessStrictSchedulePolicy(hearing, candidates);
    if (!assessment.allowed) {
      throw new ConflictException({
        code: assessment.reasonCode,
        message: assessment.message,
      });
    }
    return assessment;
  }
}

export function assessStrictSchedulePolicy(
  hearing: { eventStatus: string; visibility: string },
  candidates: Array<{ capturePolicy: string; resolutionState: string }>,
): StrictScheduleAssessment {
  if (hearing.visibility !== 'public') {
    return {
      allowed: false,
      state: 'BLOCKED',
      reasonCode: 'NON_PUBLIC_PROCEEDING',
      message: 'This proceeding is not public and cannot be scheduled for public server capture.',
    };
  }
  if (hearing.eventStatus === 'canceled') {
    return {
      allowed: false,
      state: 'BLOCKED',
      reasonCode: 'EVENT_CANCELED',
      message: 'This proceeding has been canceled.',
    };
  }
  if (hearing.eventStatus === 'completed') {
    return {
      allowed: false,
      state: 'BLOCKED',
      reasonCode: 'EVENT_COMPLETED',
      message: 'This proceeding is already complete.',
    };
  }
  if (!candidates.length) {
    return {
      allowed: true,
      state: 'PREFLIGHT_REQUIRED',
      reasonCode: 'STREAM_NOT_RESOLVED_YET',
      message: 'Recording demand was accepted; Capiro will resolve the official stream near the start time.',
    };
  }

  const policies = new Set(candidates.map((candidate) => candidate.capturePolicy));
  if (policies.has('SERVER_CAPTURE_ALLOWED')) {
    return {
      allowed: true,
      state: 'READY',
      reasonCode: 'SERVER_CAPTURE_ALLOWED',
      message: 'An approved server-capture source is available.',
    };
  }

  // REVIEW_REQUIRED is the only unresolved policy allowed to become demand.
  // Worker-side preflight can later promote it only through the Phase 5 policy
  // boundary. A WAITING state on a browser/licensed/blocked source is never a
  // permission grant.
  if (policies.has('REVIEW_REQUIRED')) {
    return {
      allowed: true,
      state: 'PREFLIGHT_REQUIRED',
      reasonCode: 'STREAM_PREFLIGHT_REQUIRED',
      message: 'Recording demand was accepted; the official source still requires preflight or re-resolution.',
    };
  }

  if (policies.has('LICENSE_REQUIRED')) {
    return {
      allowed: false,
      state: 'LICENSE_REQUIRED',
      reasonCode: 'LICENSE_REQUIRED',
      message: 'The currently verified source requires a license before server capture can be enabled.',
    };
  }
  if (policies.has('BROWSER_CAPTURE_ONLY')) {
    return {
      allowed: false,
      state: 'BROWSER_ONLY',
      reasonCode: 'BROWSER_CAPTURE_ONLY',
      message: 'The currently verified source is browser-capture only; unattended server capture is not permitted.',
    };
  }
  return {
    allowed: false,
    state: 'BLOCKED',
    reasonCode: 'NO_SERVER_CAPTURABLE_SOURCE',
    message: 'No currently verified source is eligible for unattended server capture.',
  };
}
