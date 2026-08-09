import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

export function parseOutreachV3StateEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
  throw new Error('Invalid OUTREACH_V3_STATE_ENABLED value');
}

@Injectable()
export class OutreachV3StateGuard implements CanActivate {
  private readonly enabled = parseOutreachV3StateEnabled(process.env.OUTREACH_V3_STATE_ENABLED);

  canActivate(_context: ExecutionContext): boolean {
    if (!this.enabled) {
      // Deliberately indistinguishable from an absent route while the future
      // state surface is dark. No tenant or feature existence is disclosed.
      throw new NotFoundException();
    }
    return true;
  }
}
