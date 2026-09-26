import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { BusinessDevelopmentFlagGuard } from './business-development-flag.guard.js';
import { BusinessDevelopmentService } from './business-development.service.js';
import {
  AddNoteDto,
  CanonicalEntityIdParam,
  CompanyDossierQueryDto,
  ConvertProspectDto,
  CreateProspectDto,
  DismissProspectDto,
  ListProspectsQueryDto,
  PreviewDuplicateHintsDto,
  ProspectDossierQueryDto,
  SavePreferencesDto,
  SearchCandidatesQueryDto,
  SearchCanonicalQueryDto,
  SearchClientsQueryDto,
  ResolveProspectIdentityDto,
  UpdateConflictDto,
  UpdateProspectDto,
} from './business-development.dto.js';
import { BusinessDevelopmentDossierFlagGuard } from './bizdev-dossier.flag.guard.js';
import { BusinessDevelopmentBriefFlagGuard } from './bizdev-brief.flag.guard.js';
import { BusinessDevelopmentClaimValidationFlagGuard } from './bizdev-claim-validation.flag.guard.js';
import { BizDevDossierService } from './bizdev-dossier.service.js';
import { BizDevBriefService } from './bizdev-brief.service.js';
import { BizDevWatchService } from './bizdev-watch.service.js';
import { BusinessDevelopmentWatchFlagGuard } from './bizdev-watch.flag.guard.js';
import type { DossierSectionKind } from './bizdev-evidence.types.js';
import {
  AcceptBriefRefreshDto,
  BriefCitationParam,
  BriefVersionParam,
  CheckBriefClaimDto,
  CreateBriefVersionDto,
  ResolveBriefCitationQueryDto,
  SaveBriefVersionDto,
  ActivateBizDevWatchDto,
  UpdateBizDevWatchDto,
  ListProspectAlertsQueryDto,
  ListTenantAlertsQueryDto,
  AlertIdParam,
} from './business-development.dto.js';

/**
 * Business Development Phase 1 routes.
 *
 * EVERY route runs RolesGuard then BusinessDevelopmentFlagGuard: when the
 * tenant flag is off (default) the whole controller 404s identically to a
 * missing route. Default role floor is `standard_user`; admin-only writes
 * (conflict/exclusion reason, preferences) are marked with @Roles('user_admin',
 * 'capiro_admin') — RolesGuard grants by role RANK, so capiro_admin also
 * passes a user_admin-marked route.
 */
const UUID_PARAM = 'prospectId';

class ProspectIdParam {
  @IsUUID()
  prospectId!: string;
}

@Controller('business-development')
@UseGuards(RolesGuard, BusinessDevelopmentFlagGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class BusinessDevelopmentController {
  constructor(
    private readonly bizdev: BusinessDevelopmentService,
    private readonly dossier: BizDevDossierService,
    private readonly brief: BizDevBriefService,
    private readonly watchSvc: BizDevWatchService,
  ) {}

  /** List/filter prospects + stage counts. */
  @Get('prospects')
  list(@CurrentTenant() ctx: TenantContext, @Query() query: ListProspectsQueryDto) {
    return this.bizdev.list(ctx, query);
  }

  /** Get a prospect by id (safe 404 on guessed/cross-tenant ids). */
  @Get(`prospects/:${UUID_PARAM}`)
  get(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.bizdev.get(ctx, params.prospectId);
  }

  /** Create a manual (unresolved) or confirmed canonical-organization prospect. */
  @Post('prospects')
  create(@CurrentTenant() ctx: TenantContext, @Body() body: CreateProspectDto) {
    return this.bizdev.create(ctx, body);
  }

  /** Tenant-only advisory duplicate hints before a manual record is saved. */
  @Post('duplicate-hints')
  previewDuplicateHints(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: PreviewDuplicateHintsDto,
  ) {
    return this.bizdev.previewDuplicateHints(ctx, body);
  }

  /** Same-firm duplicate hints (advisory; no merge, no global writeback). */
  @Get(`prospects/:${UUID_PARAM}/duplicate-hints`)
  duplicateHints(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.bizdev.duplicateHints(ctx, params.prospectId);
  }

  /** Update details / owner / stage / next action / watch. Stage `won` never converts. */
  @Patch(`prospects/:${UUID_PARAM}`)
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: UpdateProspectDto,
  ) {
    return this.bizdev.update(ctx, params.prospectId, body);
  }

  /** Add a private note; returns the ordered activity list. */
  @Post(`prospects/:${UUID_PARAM}/notes`)
  addNote(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: AddNoteDto,
  ) {
    return this.bizdev.addNote(ctx, params.prospectId, body.body);
  }

  /** Ordered activity/history (oldest → newest). */
  @Get(`prospects/:${UUID_PARAM}/history`)
  history(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.bizdev.history(ctx, params.prospectId);
  }

  /**
   * Conflict/exclusion change. The SENSITIVE reason field means this whole
   * route is admin-only: user_admin or capiro_admin.
   */
  @Put(`prospects/:${UUID_PARAM}/conflict`)
  @Roles('user_admin', 'capiro_admin')
  updateConflict(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: UpdateConflictDto,
  ) {
    return this.bizdev.updateConflict(ctx, params.prospectId, body);
  }

  /** Dismiss (soft; history preserved). */
  @Post(`prospects/:${UUID_PARAM}/dismiss`)
  @HttpCode(200)
  dismiss(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: DismissProspectDto,
  ) {
    return this.bizdev.dismiss(ctx, params.prospectId, body.reason);
  }

  /** Restore a dismissed prospect. */
  @Post(`prospects/:${UUID_PARAM}/restore`)
  @HttpCode(200)
  restore(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.bizdev.restore(ctx, params.prospectId);
  }

  /** Transactional link-or-convert. Idempotent on retry. */
  @Post(`prospects/:${UUID_PARAM}/convert`)
  @HttpCode(200)
  convert(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: ConvertProspectDto,
  ) {
    return this.bizdev.convert(ctx, params.prospectId, body);
  }

  /** Confirm the canonical identity of a previously unresolved prospect
   * (keeps id + history; structured duplicate-review response on conflict). */
  @Post(`prospects/:${UUID_PARAM}/identity`)
  @HttpCode(200)
  resolveIdentity(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: ResolveProspectIdentityDto,
  ) {
    return this.bizdev.resolveIdentity(ctx, params.prospectId, body);
  }

  /** Read firm preferences (any member). */
  @Get('preferences')
  getPreferences(@CurrentTenant() ctx: TenantContext) {
    return this.bizdev.getPreferences(ctx);
  }

  /** Save firm preferences — admins only. */
  @Put('preferences')
  @Roles('user_admin', 'capiro_admin')
  savePreferences(@CurrentTenant() ctx: TenantContext, @Body() body: SavePreferencesDto) {
    return this.bizdev.savePreferences(ctx, body);
  }

  /** Active members of this tenant (owner assignment options). */
  @Get('member-options')
  memberOptions(@CurrentTenant() ctx: TenantContext) {
    return this.bizdev.memberOptions(ctx);
  }

  /** Bounded canonical organization search (identity-rules-visible only). */
  @Get('search/canonical-organizations')
  searchCanonical(@CurrentTenant() ctx: TenantContext, @Query() query: SearchCanonicalQueryDto) {
    return this.bizdev.searchCanonicalOrganizations(ctx, query.q, query.limit);
  }

  /** Bounded client candidate lookup (this tenant only). */
  @Get('search/clients')
  searchClients(@CurrentTenant() ctx: TenantContext, @Query() query: SearchClientsQueryDto) {
    return this.bizdev.searchClients(ctx, query.q, query.limit);
  }

  // ── Phase 2 — read-only dossier surface (additional flag guard) ──────────

  /**
   * Candidate discovery search. Page-level bounded reads, deterministic
   * ordering, stable offset paging, no live provider calls.
   */
  @Get('search/candidates')
  @UseGuards(BusinessDevelopmentDossierFlagGuard)
  searchCandidates(@CurrentTenant() ctx: TenantContext, @Query() query: SearchCandidatesQueryDto) {
    return this.dossier.searchCandidates(ctx, {
      q: query.q,
      agency: query.agency,
      issue: query.issue,
      geography: query.geography,
      service: query.service,
      includeExcluded: query.includeExcluded === '1',
      limit: query.limit,
      offset: query.offset,
    });
  }

  /** Canonical company dossier (global_public or caller-tenant rows only). */
  @Get('dossier/companies/:canonicalEntityId')
  @UseGuards(BusinessDevelopmentDossierFlagGuard)
  companyDossier(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: CanonicalEntityIdParam,
    @Query() query: CompanyDossierQueryDto,
  ) {
    return this.dossier.companyDossier(
      ctx,
      params.canonicalEntityId,
      query.section as DossierSectionKind | undefined,
    );
  }

  /** Prospect dossier — full dossier for resolved prospects; honest
   * unresolved/ambiguous identity options otherwise. Tenant-owned only. */
  @Get(`prospects/:${UUID_PARAM}/dossier`)
  @UseGuards(BusinessDevelopmentDossierFlagGuard)
  prospectDossier(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Query() query: ProspectDossierQueryDto,
  ) {
    return this.dossier.prospectDossier(
      ctx,
      params.prospectId,
      query.section as DossierSectionKind | undefined,
    );
  }

  // ── Phase 4 — prospect brief surface (additional brief flag guard) ────────

  /** Get the current brief (root + current version) for a prospect.
   * `{ brief: null }` when none exists yet. */
  @Get(`prospects/:${UUID_PARAM}/brief`)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  getCurrentBrief(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.brief.getCurrentBrief(ctx, params.prospectId);
  }

  /** Create/generate the initial saved version. Idempotent on the key. */
  @Post(`prospects/:${UUID_PARAM}/brief/versions`)
  @HttpCode(200)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  createBriefVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: CreateBriefVersionDto,
  ) {
    return this.brief.createInitialVersion(ctx, params.prospectId, body);
  }

  /** Save an edited version. Version-checked + idempotent. */
  @Put(`prospects/:${UUID_PARAM}/brief/versions`)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  saveBriefVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: SaveBriefVersionDto,
  ) {
    return this.brief.saveEditedVersion(ctx, params.prospectId, {
      idempotencyKey: body.idempotencyKey,
      expectedVersionNumber: body.expectedVersionNumber,
      sections: body.sections,
      title: body.title,
    });
  }

  /** Build a refresh proposal/diff — never writes. */
  @Get(`prospects/:${UUID_PARAM}/brief/refresh-proposal`)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  buildRefreshProposal(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.brief.buildRefreshProposal(ctx, params.prospectId);
  }

  /** Explicitly accept a refresh proposal as a new saved version. */
  @Post(`prospects/:${UUID_PARAM}/brief/refresh-accept`)
  @HttpCode(200)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  acceptRefreshProposal(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: AcceptBriefRefreshDto,
  ) {
    return this.brief.acceptRefreshProposal(ctx, params.prospectId, {
      idempotencyKey: body.idempotencyKey,
      expectedVersionNumber: body.expectedVersionNumber,
      keepUserEdits: body.keepUserEdits,
    });
  }

  /** List version summaries (oldest → newest). */
  @Get(`prospects/:${UUID_PARAM}/brief/versions`)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  listBriefVersions(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.brief.listVersions(ctx, params.prospectId);
  }

  /** Get one specific saved version (immutable history stays readable). */
  @Get(`prospects/:${UUID_PARAM}/brief/versions/:versionNumber`)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  getBriefVersion(@CurrentTenant() ctx: TenantContext, @Param() params: BriefVersionParam) {
    return this.brief.getVersion(ctx, params.prospectId, params.versionNumber);
  }

  /** Resolve a saved citation to an inspectable dossier source, or an
   * explicit unavailable/changed limitation. */
  @Get(`prospects/:${UUID_PARAM}/brief/citations`)
  @UseGuards(BusinessDevelopmentBriefFlagGuard)
  resolveBriefCitation(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: BriefCitationParam,
    @Query() query: ResolveBriefCitationQueryDto,
  ) {
    return this.brief.resolveCitation(ctx, params.prospectId, query.index);
  }

  /** Deterministic claim validation (identity/citation/exact amount/date/
   * stage). BD-CLAIM Jev semantic validation remains dark. */
  @Post('brief/claim-check')
  @HttpCode(200)
  @UseGuards(BusinessDevelopmentBriefFlagGuard, BusinessDevelopmentClaimValidationFlagGuard)
  checkBriefClaim(@CurrentTenant() ctx: TenantContext, @Body() body: CheckBriefClaimDto) {
    return this.brief.checkClaim(ctx, {
      prospectId: body.prospectId,
      versionNumber: body.versionNumber,
      citationIndex: body.citationIndex,
      claimType: body.claimType,
      expected: body.expected,
    });
  }

  // ── Phase 5 — prospect watch & alerts ─────────────────────────────────────
  // Every route carries the ADDITIONAL BusinessDevelopmentWatchFlagGuard on
  // top of the class-level RolesGuard + BusinessDevelopmentFlagGuard: the
  // watch flag is off by default and a disabled surface 404s identically to
  // a missing route.

  /** Activate (or re-activate) the prospect's watch. */
  @Post(`prospects/:${UUID_PARAM}/watch`)
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  activateBizDevWatch(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: ActivateBizDevWatchDto,
  ) {
    return this.watchSvc.activateWatch(ctx, params.prospectId, {
      categories: body.categories,
      ownerUserId: body.ownerUserId,
    });
  }

  /** Current watch state incl. per-source health. */
  @Get(`prospects/:${UUID_PARAM}/watch`)
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  getBizDevWatch(@CurrentTenant() ctx: TenantContext, @Param() params: ProspectIdParam) {
    return this.watchSvc.getWatch(ctx, params.prospectId);
  }

  /** Pause/resume/end, mute, category and owner preferences. */
  @Patch(`prospects/:${UUID_PARAM}/watch`)
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  updateBizDevWatch(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Body() body: UpdateBizDevWatchDto,
  ) {
    return this.watchSvc.updateWatch(ctx, params.prospectId, {
      status: body.status,
      mutedUntil: body.mutedUntil,
      categories: body.categories,
      ownerUserId: body.ownerUserId,
    });
  }

  /** Prospect-local alert inbox (newest first, keyset paginated). */
  @Get(`prospects/:${UUID_PARAM}/alerts`)
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  listBizDevProspectAlerts(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: ProspectIdParam,
    @Query() query: ListProspectAlertsQueryDto,
  ) {
    return this.watchSvc.listProspectAlerts(ctx, params.prospectId, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  /** Mark one alert read (idempotent, per-recipient delivery row). */
  @Post(`prospects/:${UUID_PARAM}/alerts/:alertId/read`)
  @HttpCode(200)
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  markBizDevAlertRead(@CurrentTenant() ctx: TenantContext, @Param() params: AlertIdParam) {
    return this.watchSvc.markAlertRead(ctx, params.prospectId, params.alertId);
  }

  /** Dismiss one alert (idempotent; implies read). */
  @Post(`prospects/:${UUID_PARAM}/alerts/:alertId/dismiss`)
  @HttpCode(200)
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  dismissBizDevAlert(@CurrentTenant() ctx: TenantContext, @Param() params: AlertIdParam) {
    return this.watchSvc.dismissAlert(ctx, params.prospectId, params.alertId);
  }

  /** Tenant top-bar notification center: current owner's alerts. */
  @Get('alerts')
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  listBizDevAlerts(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListTenantAlertsQueryDto,
  ) {
    return this.watchSvc.listTenantAlerts(ctx, {
      limit: query.limit,
      cursor: query.cursor,
      unreadOnly: query.unreadOnly,
    });
  }

  /** Mark every owned alert read (idempotent). */
  @Post('alerts/read-all')
  @HttpCode(200)
  @UseGuards(BusinessDevelopmentWatchFlagGuard)
  markAllBizDevAlertsRead(@CurrentTenant() ctx: TenantContext) {
    return this.watchSvc.markAllAlertsRead(ctx);
  }
}
