import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  parseCoreRetainedAuthorityProbeBody,
  type CoreRetainedAuthorityProbeCryptographicVerifier,
} from '@capiro/shared/core-retained-authority-probe';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { applicationMembershipRequest } from './application-membership-request.js';
import { createRetainedNativeAuthorityProbeReceiver } from './retained-native-authority.js';
import { RetainedPrincipalService } from './retained-principal.service.js';

export const RETAINED_FLORIDA_PROBE_VERIFIER = Symbol(
  'retained-florida-probe-verifier',
);

/** Private fixed-purpose source boundary; intentionally not mounted in AppModule. */
@Controller('clio/application-authority')
export class RetainedFloridaCurrentController {
  constructor(
    private readonly tenant: TenantContextMiddleware,
    private readonly principal: RetainedPrincipalService,
    @Inject(RETAINED_FLORIDA_PROBE_VERIFIER)
    private readonly probe: CoreRetainedAuthorityProbeCryptographicVerifier | null,
  ) {}

  @Post('retained-florida-native-current')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async nativeCurrent(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const control = applicationMembershipRequest(req, res);
    try {
      return await control.run(async () => {
        if (!this.probe)
          throw new ServiceUnavailableException(
            'Retained native verifier unavailable',
          );
        let parsed: ReturnType<typeof parseCoreRetainedAuthorityProbeBody>;
        let verified: ReturnType<
          ReturnType<
            typeof createRetainedNativeAuthorityProbeReceiver
          >['verifyCryptographically']
        >;
        try {
          parsed = parseCoreRetainedAuthorityProbeBody(body);
          verified = createRetainedNativeAuthorityProbeReceiver(
            this.probe,
          ).verifyCryptographically(req.headers.authorization, {
            nowMs: Date.now(),
            deadlineMs: control.deadlineMs,
            selector: parsed.selector,
          });
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'status' in error &&
            error.status === 503
          )
            throw new ServiceUnavailableException(
              'Retained native verifier unavailable',
            );
          throw new UnauthorizedException('Invalid retained authority probe');
        }
        control.assertActive();
        const current =
          await this.tenant.requiresVerifiedRetainedNativeAuthority(verified);
        control.assertActive();
        return {
          principal: verified.principal,
          identityRevision: current.identity.identityRevision,
          checkedAtMs: Date.now(),
          originalExpiresAtMs: Math.min(
            verified.originalExpiresAtMs,
            current.identity.expiresAtMs,
            control.deadlineMs,
          ),
        };
      });
    } finally {
      control.close();
    }
  }

  @Post('retained-florida-current')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async dataCurrent(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const control = applicationMembershipRequest(req, res);
    try {
      return await control.run(async () => {
        const current = await this.principal.verifyCurrent(
          req.headers.authorization,
          'get_florida_budget_project',
          body,
          control,
        );
        control.assertActive();
        return current.receipt;
      });
    } finally {
      control.close();
    }
  }
}
