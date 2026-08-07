import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const FUNDING_OPPORTUNITIES_FEATURE = 'funding_opportunities';

/**
 * The client-first triage inbox, gated SEPARATELY from the master surface.
 *
 * Two flags, not one, because the inbox changes what the default experience IS.
 * A tenant already using the catalog must be able to keep it while the inbox is
 * canaried, and turning the inbox on must not be a side effect of turning the
 * feature on.
 */
export const FUNDING_OPPORTUNITIES_INBOX_FEATURE = 'funding_opportunities_client_inbox';

/**
 * P23. Gates acquisition-position scoring specifically. Unlike the two flags
 * above, nothing sits behind this as a ROUTE — the field lives inside the
 * existing, already-flagged opportunity response — so this flag is never
 * read by a guard. `isFundingOpportunitiesFeatureEnabled` below is the
 * boolean-returning read `funding-opportunities.service.ts` uses instead,
 * so "flag off" can mean "compute nothing, respond exactly like P22" rather
 * than "404 the whole endpoint".
 */
export const FUNDING_OPPORTUNITIES_VEHICLE_FIT_FEATURE = 'funding_opportunities_vehicle_fit';

/**
 * P26. Gates the agency-forecast surface: the forecast read route below, and
 * (web side) the forecast card, the forecast source filter and the forecast
 * detail sections.
 *
 * A ROUTE flag, like the inbox's and unlike P23's — the forecast read is its own
 * endpoint returning its own record shape, so "off" can mean the honest 404 a
 * route that was never deployed gives, rather than a `FundingOpportunity` with
 * forecast-shaped holes in it. A forecast is not a `FundingOpportunity` and is
 * deliberately never served as one.
 *
 * Separate from the master flag and from the inbox flag for the same reason
 * those two are separate from each other: turning agency forecasts on changes
 * what a tenant's triage queue CONTAINS, and that has to be a deliberate,
 * separately reviewable decision — not a side effect of enabling the inbox.
 */
export const FUNDING_OPPORTUNITIES_FORECASTS_FEATURE = 'funding_opportunities_forecasts';

/**
 * P28. Gates the notice-history timeline: the read route below and the
 * timeline panel on the detail surface.
 *
 * A ROUTE flag, like the inbox's and the forecast one. With it off the endpoint
 * 404s and the detail surface keeps the P12 placeholder it has carried since —
 * which is honest, because "amendment history is not available here" and "this
 * solicitation was never amended" are different statements and only the first
 * is true.
 */
export const FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE =
  'funding_opportunities_notice_history';

/**
 * P29/P30/P31. Gates the whole document story: attachments, their extracted
 * text, and the requirements extracted from that text.
 *
 * ONE flag for three phases, deliberately. They are not independently useful —
 * requirements without text is an empty list, text without archived attachments
 * has nothing to be the text OF — so three flags would mean three ways to
 * configure a half-working surface. The plan names
 * `funding_opportunities_documents` for exactly this span.
 */
export const FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE = 'funding_opportunities_documents';

/**
 * P33/P34. Gates the Government Landscape packet and the action plan derived
 * from it.
 *
 * ONE flag for both, because an action plan without the landscape it is derived
 * from is a list of steps with no evidence behind them — the two are not
 * independently useful, and two flags would mean a way to configure exactly
 * that.
 */
export const FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE =
  'funding_opportunities_government_landscape';

/**
 * P35. Gates the pursuit pipeline board and every stage transition.
 *
 * Its OWN flag rather than a reuse, unlike P34's: the pipeline is a different
 * kind of thing from the landscape — it WRITES, it replaces the Saved/Pursuing
 * tabs a team already uses, and turning it on changes how work is tracked rather
 * than adding a panel. Folding it into an existing flag would mean no way to
 * canary the write path on its own.
 *
 * Flag OFF is not a degraded pipeline: the existing workflow tabs stay exactly as
 * they are, because `workflow_status` is still the column both code paths write.
 */
export const FUNDING_OPPORTUNITIES_PIPELINE_V2_FEATURE = 'funding_opportunities_pipeline_v2';

/**
 * P37/P38. Gates Meri's Funding Opportunities surface: the six typed local
 * tools and the structured assessment built from the same packet.
 *
 * ONE flag for both, and unlike P34's reuse of P33's this is not a
 * "not independently useful" argument — it is a narrower one. P38's assessment
 * is composed from the same reads P37's tools expose, and a workspace that has
 * decided Meri may not answer questions about opportunities has not decided
 * that Meri may still write an executive assessment about one. Two flags would
 * make that combination configurable, and there is no reason anyone would want
 * it.
 *
 * Read TWO ways, deliberately. As a route guard (P38's assessment endpoint,
 * 404 when off) and as a plain boolean inside the tools adapter, where "off"
 * must mean a typed `disabled` RESULT the model can quote rather than a thrown
 * 404 mid-turn. Both go through `isFundingOpportunitiesFeatureEnabled`, so the
 * two readings can never disagree about what enabled means.
 */
export const FUNDING_OPPORTUNITIES_MERI_V2_FEATURE = 'funding_opportunities_meri_v2';

/**
 * The same `intel_feature_flag` READ every guard below uses (`withSystem`, no
 * ::uuid cast — see the guard's own docblock for why both details matter),
 * factored out so a route guard and a data-shape check can never drift into
 * disagreeing about what "enabled" means for the same flag row.
 *
 * DELIBERATELY DOES NOT CATCH. A guard and a plain data check fail closed for
 * DIFFERENT reasons and at different volumes — a guard 404s and logs loudly,
 * because a broken read there hides an entire endpoint; a field like P23's
 * acquisition position can fail closed quietly, because its absence is
 * additive. Swallowing the error HERE would make both callers' own
 * try/catch dead code and turn a broken flag read silent everywhere,
 * exactly the failure mode this file's own docblock already names as having
 * happened once (the District Nexus `::uuid` incident). Every caller must
 * wrap this itself.
 */
export async function isFundingOpportunitiesFeatureEnabled(
  prisma: PrismaService,
  tenantId: string,
  feature: string,
): Promise<boolean> {
  const rows = await prisma.withSystem((tx) =>
    tx.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok
      FROM intel_feature_flag
      WHERE feature = ${feature}
        AND tenant_id = ${tenantId}
        AND enabled = true
      LIMIT 1
    `,
  );
  return rows.length > 0;
}

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

  constructor(protected readonly prisma: PrismaService) {}

  /**
   * Which flag this guard reads. Overridden by the inbox guard below; everything
   * else about the check — including every fail-closed path — is shared, so a
   * second flag cannot accidentally get weaker semantics than the first.
   */
  protected feature(): string {
    return FUNDING_OPPORTUNITIES_FEATURE;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = req.tenantContext?.tenantId;

    // No tenant context means the auth middleware did not run. Fail closed, with
    // the same 404 a disabled flag produces so this path leaks nothing either.
    if (!tenantId) throw new NotFoundException();

    // Shares its fail-closed SQL with isFundingOpportunitiesFeatureEnabled
    // (P23) so a route guard and a data-shape check can never disagree about
    // what "enabled" means for the same flag row. This class still owns the
    // ERROR LOGGING and the 404-on-disabled behavior a route guard needs,
    // which the shared helper deliberately does not do (see its own doc).
    let enabled: boolean;
    try {
      enabled = await isFundingOpportunitiesFeatureEnabled(this.prisma, tenantId, this.feature());
    } catch (error) {
      this.logger.error(
        `${this.feature()} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
    if (!enabled) throw new NotFoundException();
    return true;
  }
}

/**
 * The inbox guard: the SAME fail-closed logic, keyed on the inbox flag.
 *
 * Subclassed rather than parameterized because Nest resolves guards by class, and
 * `@UseGuards(FlagGuard('x'))` would need a factory whose instances the DI
 * container cannot inject `PrismaService` into. Overriding one field keeps the
 * fail-closed behaviour — no tenant context, no row, or a THROWING read all 404 —
 * in exactly one place, so the inbox cannot drift into failing open.
 *
 * Routes carrying this guard also carry the master guard, so a tenant without
 * `funding_opportunities` never reaches the inbox check at all.
 */
@Injectable()
export class FundingOpportunitiesInboxFlagGuard extends FundingOpportunitiesFlagGuard {
  protected override feature(): string {
    return FUNDING_OPPORTUNITIES_INBOX_FEATURE;
  }
}

/**
 * P26's forecast guard: the SAME fail-closed logic, keyed on the forecast flag.
 *
 * Subclassed for the identical reason the inbox guard is — Nest resolves guards
 * by class, so a parameterized factory could not have `PrismaService` injected
 * into its instances. Every fail-closed path (no tenant context, no row, a
 * THROWING read) stays in the base class, so this cannot drift into failing
 * open.
 *
 * Routes carrying this also carry the master guard, so a tenant without
 * `funding_opportunities` never reaches the forecast check at all.
 */
@Injectable()
export class FundingOpportunitiesForecastFlagGuard extends FundingOpportunitiesFlagGuard {
  protected override feature(): string {
    return FUNDING_OPPORTUNITIES_FORECASTS_FEATURE;
  }
}

/** P28's notice-history guard. Same fail-closed base, keyed on its own flag. */
@Injectable()
export class FundingOpportunitiesNoticeHistoryFlagGuard extends FundingOpportunitiesFlagGuard {
  protected override feature(): string {
    return FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE;
  }
}

/** P29-P31's documents guard. Same fail-closed base, keyed on its own flag. */
@Injectable()
export class FundingOpportunitiesDocumentsFlagGuard extends FundingOpportunitiesFlagGuard {
  protected override feature(): string {
    return FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE;
  }
}

/** P33/P34's landscape guard. Same fail-closed base, keyed on its own flag. */
@Injectable()
export class FundingOpportunitiesLandscapeFlagGuard extends FundingOpportunitiesFlagGuard {
  protected override feature(): string {
    return FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE;
  }
}

/** P35's pipeline guard. Same fail-closed base, keyed on its own flag. */
@Injectable()
export class FundingOpportunitiesPipelineFlagGuard extends FundingOpportunitiesFlagGuard {
  protected override feature(): string {
    return FUNDING_OPPORTUNITIES_PIPELINE_V2_FEATURE;
  }
}

/** P38's assessment guard. Same fail-closed base, keyed on the Meri v2 flag. */
@Injectable()
export class FundingOpportunitiesMeriFlagGuard extends FundingOpportunitiesFlagGuard {
  protected override feature(): string {
    return FUNDING_OPPORTUNITIES_MERI_V2_FEATURE;
  }
}
