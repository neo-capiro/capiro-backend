import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const FUNDING_OPPORTUNITIES_FEATURE = 'funding_opportunities';

/**
 * Gates every Funding Opportunities endpoint on a per-tenant
 * `funding_opportunities` row in `intel_feature_flag`.
 *
 * ── Three decisions, and one deliberate difference from District Nexus ───────
 *
 * 404, NOT 403 — matching DistrictNexusFlagGuard and intel-api's own feature
 * guards. A 403 advertises that the capability exists and this tenant is not
 * entitled to it; a 404 is indistinguishable from a route that was never
 * deployed.
 *
 * withSystem, NOT withTenant — `intel_feature_flag` is owned by intel-api and
 * has RLS FORCE-enabled. apps/api's connection sets no tenant GUC, so a plain
 * read returns ZERO rows and every tenant would look disabled: the feature would
 * be permanently dark with no error to explain why.
 *
 * NO ::uuid CAST — `intel_feature_flag.tenant_id` is TEXT (intel-api declares it
 * `tenantId String` with no @db.Uuid, and its RLS policy casts the other way:
 * `tenant_id = (current_tenant_id())::text`). The District Nexus rollout shipped
 * with a uuid cast, every read threw `42883 operator does not exist: text =
 * uuid`, hit the catch, failed closed — and the feature 404'd for a tenant whose
 * flag was genuinely on. It could not surface until the flag was first switched
 * on for somebody, because with no rows anywhere the answer was "denied" either
 * way.
 *
 * THE DIFFERENCE: there is deliberately NO internal-tenant fallback here.
 * DistrictNexusFlagGuard treats the `capiro-internal` slug as implicitly enabled,
 * which means merging it enabled the feature for a tenant. This guard requires an
 * explicit enabled row for EVERY tenant including capiro-internal, so merging
 * this PR changes nothing anywhere. Turning it on — even for the internal canary
 * — is an explicit, reviewable flag write, listed in
 * docs/runbooks/funding-opportunities-rollout.md as a step requiring approval.
 */
@Injectable()
export class FundingOpportunitiesFlagGuard implements CanActivate {
  private readonly logger = new Logger(FundingOpportunitiesFlagGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = req.tenantContext?.tenantId;

    // No tenant context means the auth middleware did not run. Fail closed, with
    // the same 404 a disabled flag produces so this path leaks nothing either.
    if (!tenantId) throw new NotFoundException();

    try {
      const rows = await this.prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          FROM intel_feature_flag
          WHERE feature = ${FUNDING_OPPORTUNITIES_FEATURE}
            AND tenant_id = ${tenantId}
            AND enabled = true
          LIMIT 1
        `,
      );
      if (rows.length === 0) throw new NotFoundException();
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      // Fail closed. A flag read that errors must not open the feature — the
      // whole point of the gate is that unseeded tenants see nothing.
      this.logger.error(
        `${FUNDING_OPPORTUNITIES_FEATURE} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
  }
}
