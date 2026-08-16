import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

export function parseOutreachV3FullGenerationEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const lower = value.toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(lower)) return true;
  if (['false', '0', 'off', 'no'].includes(lower)) return false;
  throw new Error('Invalid OUTREACH_V3_FULL_GENERATION_ENABLED value');
}

@Injectable()
export class OutreachV3FullGenerationGuard implements CanActivate {
  private readonly enabled = parseOutreachV3FullGenerationEnabled(
    process.env.OUTREACH_V3_FULL_GENERATION_ENABLED,
  );

  canActivate(_context: ExecutionContext): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
