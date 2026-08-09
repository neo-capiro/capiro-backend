import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { parseOutreachV3StateEnabled } from '../api/outreach-v3-state.guard.js';

export function parseOutreachV3ReasoningEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
  throw new Error('Invalid OUTREACH_V3_REASONING_ENABLED value');
}

@Injectable()
export class OutreachV3ReasoningGuard implements CanActivate {
  private readonly reasoningEnabled = parseOutreachV3ReasoningEnabled(
    process.env.OUTREACH_V3_REASONING_ENABLED,
  );
  private readonly stateEnabled = parseOutreachV3StateEnabled(
    process.env.OUTREACH_V3_STATE_ENABLED,
  );

  canActivate(_context: ExecutionContext): boolean {
    if (!this.reasoningEnabled || !this.stateEnabled) throw new NotFoundException();
    return true;
  }
}
