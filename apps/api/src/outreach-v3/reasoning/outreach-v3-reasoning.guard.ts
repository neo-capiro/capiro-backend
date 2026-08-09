import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { parseOutreachV3StateEnabled } from '../api/outreach-v3-state.guard.js';

export function parseOutreachV3ReasoningEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('OUTREACH_V3_REASONING_ENABLED must be exactly true or false when set');
}

@Injectable()
export class OutreachV3ReasoningGuard implements CanActivate {
  private readonly reasoningEnabled = parseOutreachV3ReasoningEnabled(
    process.env.OUTREACH_V3_REASONING_ENABLED,
  );
  private readonly stateEnabled = parseOutreachV3StateEnabled(
    process.env.OUTREACH_V3_STATE_ENABLED,
  );

  canActivate(): boolean {
    if (!this.reasoningEnabled || !this.stateEnabled) throw new NotFoundException();
    return true;
  }
}
