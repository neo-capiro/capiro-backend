import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/config.schema.js';
import type { ApplicationMembershipReceipt } from './application-membership.js';
import { applicationMembershipRequest } from './application-membership-request.js';
import { ApplicationMembershipService } from './application-membership.service.js';
import { previewNativeReadMode } from './preview-native-read-mode.js';

const unavailable = () => new ServiceUnavailableException('Preview reads unavailable');

@Injectable()
export class PreviewNativeReadService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly membership: ApplicationMembershipService,
  ) {}

  /**
   * A preview Host without the task-specific setting fails closed, including
   * when the ALB GET rule is absent and a production API task sees the Host.
   * The preview task also refuses these GETs under any other Host.
   */
  mode(req: Request, res: Response): boolean {
    const enabled = this.config.get('PREVIEW_NATIVE_GETS_ENABLED', { infer: true });
    const mode = previewNativeReadMode(enabled === true, req.headers.host);
    if (mode !== 'ordinary') {
      res.setHeader('Cache-Control', 'no-store');
      if (mode === 'unavailable') throw unavailable();
    }
    return mode === 'preview';
  }

  /**
   * The canonical native membership owner checks the live Clerk session,
   * current tenant/member, and nonarchived ethical-wall-visible client roster.
   * Its revision includes each client's current row; a second complete read
   * stops a changed grant, archive or row from escaping after async I/O.
   */
  async run<T>(
    req: Request,
    res: Response,
    ctx: TenantContext,
    operation: (clientIds: readonly string[]) => Promise<T>,
  ): Promise<T> {
    if (!this.mode(req, res)) throw unavailable();
    res.setHeader('Cache-Control', 'no-store');
    const control = applicationMembershipRequest(req, res);
    try {
      return await control.run(async () => {
        const before = await this.membership.read(req, ctx, control);
        control.assertActive();
        this.assertCurrent(before, ctx);
        const result = await operation(before.clientIds);
        control.assertActive();
        const after = await this.membership.read(req, ctx, control);
        control.assertActive();
        this.assertCurrent(after, ctx);
        if (before.membershipRevision !== after.membershipRevision ||
            before.role !== after.role ||
            before.clientIds.length !== after.clientIds.length ||
            before.clientIds.some((id, index) => id !== after.clientIds[index])) {
          throw new ConflictException('Current membership changed; reload');
        }
        return result;
      });
    } finally {
      control.close();
    }
  }

  private assertCurrent(receipt: ApplicationMembershipReceipt, ctx: TenantContext): void {
    if (receipt.status !== 'active' || receipt.tenantId !== ctx.tenantId ||
        receipt.actorId !== ctx.userId || receipt.role !== ctx.role ||
        !Number.isSafeInteger(receipt.expiresAtMs) || receipt.expiresAtMs <= Date.now()) {
      throw new ForbiddenException('Current membership unavailable');
    }
  }
}
