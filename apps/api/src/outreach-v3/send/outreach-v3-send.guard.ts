import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

export function parseOutreachV3SendEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  throw new Error('Invalid OUTREACH_V3_SEND_ENABLED value');
}

@Injectable()
export class OutreachV3SendGuard implements CanActivate {
  private readonly enabled = parseOutreachV3SendEnabled(process.env.OUTREACH_V3_SEND_ENABLED);

  canActivate(_context: ExecutionContext): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
