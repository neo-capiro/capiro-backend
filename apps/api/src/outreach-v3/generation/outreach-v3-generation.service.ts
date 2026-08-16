import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { buildOutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';

@Injectable()
export class OutreachV3GenerationService {
  constructor(private readonly sessions: OutreachSessionService) {}

  /**
   * Read-only planning boundary for Workstream C.
   *
   * This method deliberately does not inject the generation gateway, job worker,
   * draft service, reviews, preflight, or mail providers. It proves the canonical
   * state can be deterministically converted into recipient-correct generation
   * slots before any model authority is added.
   */
  async plan(ctx: TenantContext, sessionId: string) {
    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot start generation.',
        409,
      );
    }

    return buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      pendingProposalCount: current.pendingProposalCount,
    });
  }
}
