import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

export function parseOutreachV3GenerationEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
  throw new Error('Invalid OUTREACH_V3_GENERATION_ENABLED value');
}

@Injectable()
export class OutreachV3GenerationGuard implements CanActivate {
  private readonly enabled = parseOutreachV3GenerationEnabled(
    process.env.OUTREACH_V3_GENERATION_ENABLED,
  );

  canActivate(_context: ExecutionContext): boolean {
    if (!this.enabled) {
      // Generation remains indistinguishable from an absent route until the
      // dedicated server-owned capability is deliberately enabled.
      throw new NotFoundException();
    }
    return true;
  }
}
