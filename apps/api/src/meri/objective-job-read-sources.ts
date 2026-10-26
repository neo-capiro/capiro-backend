import { ForbiddenException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext } from '@capiro/shared';
import type { EngagementService } from '../engagement/engagement.service.js';
import type { ResearchPortfoliosService } from '../research-portfolios/research-portfolios.service.js';
import type { ResearchPortfolioChangesService } from '../research-portfolios/research-portfolio-changes.service.js';
import type { ResearchPortfolioReviewService } from '../research-portfolios/research-portfolio-review.service.js';
import type { ResearchPortfolioAnalyticsService } from '../research-portfolios/research-portfolio-analytics.service.js';
import { parseApplicationReadModeObservationRequest } from '../auth/application-read-mode-observation.service.js';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import type { MeriToolsService } from './meri-tools.service.js';
import { retainedReadObject } from './retained-read-context.js';
import { CONNECTED_APP_READ_OPERATIONS } from './connected-app-read.contract.js';
import type { ConnectedAppReadService } from './connected-app-read.service.js';
import { assertMeriToolAllowed } from './meri-tool-allowlist.js';
import type { MicrosoftGraphSyncService } from '../engagement/microsoft/microsoft-graph-sync.service.js';
import { TEAMS_READ_OPERATIONS, parseTeamsInput, type TeamsReadOperation } from '../engagement/microsoft/microsoft-teams-contract.js';

const refused = () => new ForbiddenException('Objective job source refused');
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** The existing GET readers behind the control's fixed job operations. Their
 * own actor ownership, portfolio grants and per-result walls remain active. */
export class ObjectiveJobReadSources {
  constructor(private readonly integrations: Pick<EngagementService, 'listIntegrations'>,
    private readonly tools: Pick<MeriToolsService, 'checkClientRef'>,
    private readonly portfolios: Pick<ResearchPortfoliosService, 'detail'>,
    private readonly changes: Pick<ResearchPortfolioChangesService, 'listChanges'>,
    private readonly reviews: Pick<ResearchPortfolioReviewService, 'listReviews' | 'getAnnualReview'>,
    private readonly analytics: Pick<ResearchPortfolioAnalyticsService, 'snapshot'>,
    private readonly connected?: Pick<ConnectedAppReadService, 'read'>,
    private readonly teams?: Pick<MicrosoftGraphSyncService, 'readTeams'>) {}

  handles(operation: string): boolean {
    return [...CONNECTED_APP_READ_OPERATIONS, ...TEAMS_READ_OPERATIONS, 'job.readMailboxes', 'job.resolveClientReference', 'job.readMode',
      'get_research_portfolio', 'get_research_portfolio_changes', 'job.readResearchEvidenceSource'].includes(operation);
  }

  async read(ctx: TenantContext, clientId: string | null, operation: string, input: unknown): Promise<unknown> {
    // Preserve the minimum role on the existing integration/RP controllers.
    if (!Number.isFinite(ROLE_RANK[ctx.role]) || ROLE_RANK[ctx.role] < ROLE_RANK.standard_user) throw refused();
    if ((TEAMS_READ_OPERATIONS as readonly string[]).includes(operation)) {
      assertMeriToolAllowed(operation);
      const request = parseTeamsInput(operation as TeamsReadOperation, input);
      if (!this.teams || (request.clientId ?? null) !== clientId) throw refused();
      return this.teams.readTeams(ctx, operation as TeamsReadOperation, request);
    }
    if ((CONNECTED_APP_READ_OPERATIONS as readonly string[]).includes(operation)) {
      assertMeriToolAllowed(operation);
      if (!this.connected || !input || typeof input !== 'object' ||
          (input as { clientId?: unknown }).clientId !== clientId) throw refused();
      return this.connected.read(ctx, operation, input);
    }
    if (operation === 'job.readMailboxes') {
      retainedReadObject(input, []);
      return this.integrations.listIntegrations(ctx);
    }
    if (operation === 'job.resolveClientReference') {
      const v = retainedReadObject(input, ['ref']);
      if (typeof v.ref !== 'string' || !v.ref.trim() || v.ref.length > 512) throw refused();
      const result = await this.tools.checkClientRef(ctx, v.ref);
      // General keeps the existing owner's current visibility decision. A
      // selected-client job additionally remains pinned to that one client.
      if (result.ok && clientId !== null && result.clientId !== clientId) throw refused();
      return result;
    }
    if (operation === 'job.readMode') {
      parseApplicationReadModeObservationRequest(input);
      // The saved-job owner already establishes current membership; do not
      // manufacture the interactive identity fields of a mode observation.
      return { evidenceAccuracyMode: resolveEvidenceAccuracyModeForTenant(ctx.tenantId, 'chat') };
    }
    if (operation === 'get_research_portfolio') {
      const v = retainedReadObject(input, ['portfolioId']);
      if (!uuid(v.portfolioId)) throw refused();
      return this.portfolios.detail(ctx, v.portfolioId);
    }
    if (operation === 'get_research_portfolio_changes') {
      const v = retainedReadObject(input, ['portfolioId', 'limit', 'cursor']);
      if (!uuid(v.portfolioId) || !Number.isInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 100 ||
          v.cursor !== null && !uuid(v.cursor)) throw refused();
      return this.changes.listChanges(ctx, v.portfolioId, v.cursor as string | null, Number(v.limit));
    }
    if (operation === 'job.readResearchEvidenceSource') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw refused();
      const source = (input as Record<string, unknown>).source;
      const v = retainedReadObject(input, source === 'reviews' ? ['portfolioId', 'source', 'lane']
        : source === 'snapshot' ? ['portfolioId', 'source', 'recordId'] : ['portfolioId', 'source']);
      if (!uuid(v.portfolioId)) throw refused();
      if (source === 'reviews') {
        if (!['mine', 'team', 'deferred', 'resolved'].includes(String(v.lane))) throw refused();
        return this.reviews.listReviews(ctx, v.portfolioId, v.lane as 'mine' | 'team' | 'deferred' | 'resolved');
      }
      if (source === 'snapshot') {
        if (!uuid(v.recordId)) throw refused();
        return this.analytics.snapshot(ctx, v.portfolioId, v.recordId);
      }
      if (source === 'annual-review') return this.reviews.getAnnualReview(ctx, v.portfolioId);
    }
    throw refused();
  }
}
