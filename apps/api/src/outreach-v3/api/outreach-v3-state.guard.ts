import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';

export function parseOutreachV3StateEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('OUTREACH_V3_STATE_ENABLED must be exactly true or false when set');
}

@Injectable()
export class OutreachV3StateGuard implements CanActivate {
  private readonly enabled = parseOutreachV3StateEnabled(process.env.OUTREACH_V3_STATE_ENABLED);

  canActivate(): boolean {
    if (!this.enabled) {
      // Deliberately indistinguishable from an absent route while the future
      // state surface is dark. No tenant or feature existence is disclosed.
      throw new NotFoundException();
    }
    return true;
  }
}
