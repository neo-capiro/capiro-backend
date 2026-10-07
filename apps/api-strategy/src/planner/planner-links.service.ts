import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlannerProjectData, PlannerTaskData } from '@capiro/strategy-verifier';

/** Canonical APIs remain authoritative for client ethical walls and private meetings. */
@Injectable()
export class PlannerLinksService {
  private readonly base: string;
  constructor(config: ConfigService) {
    this.base = (
      config.get<string>('API_INTERNAL_URL') ??
      config.get<string>('API_BASE_URL') ??
      'https://app.capiro.ai'
    ).replace(/\/+$/, '');
  }
  async validate(
    data: Pick<PlannerProjectData, 'clientId'> & Partial<Pick<PlannerTaskData, 'meetingId'>>,
    authorization: string | undefined,
  ) {
    const paths = [
      data.clientId && `/api/clients/${data.clientId}`,
      data.meetingId && `/api/engagement/meetings/${data.meetingId}`,
    ].filter(Boolean);
    if (paths.length && !authorization?.startsWith('Bearer '))
      throw new ForbiddenException('User authorization is required to link Capiro records');
    for (const path of paths) {
      let response: Response;
      try {
        response = await fetch(`${this.base}${path}`, {
          headers: { authorization: authorization! },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
      } catch {
        throw new ServiceUnavailableException('Could not verify the linked Capiro record');
      }
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status))
        throw new ForbiddenException('Linked record is unavailable to you');
      if (!response.ok)
        throw new ServiceUnavailableException('Could not verify the linked Capiro record');
    }
  }
}
