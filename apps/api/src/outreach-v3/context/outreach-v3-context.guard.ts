import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

export function parseOutreachV3ContextEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const normalized = value.toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  throw new Error('Invalid OUTREACH_V3_CONTEXT_ENABLED value');
}

@Injectable()
export class OutreachV3ContextGuard implements CanActivate {
  private readonly enabled = parseOutreachV3ContextEnabled(
    process.env.OUTREACH_V3_CONTEXT_ENABLED,
  );

  canActivate(_context: ExecutionContext): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
