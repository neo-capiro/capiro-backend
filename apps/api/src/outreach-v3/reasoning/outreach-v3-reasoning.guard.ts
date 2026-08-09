import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

export function parseOutreachV3ReasoningEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('OUTREACH_V3_REASONING_ENABLED must be exactly true or false when set');
}

@Injectable()
export class OutreachV3ReasoningGuard implements CanActivate {
  private readonly enabled = parseOutreachV3ReasoningEnabled(
    process.env.OUTREACH_V3_REASONING_ENABLED,
  );

  canActivate(): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
