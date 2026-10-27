import { DefenseBudgetClientWatchModule } from '../defense-budget-client-watch/defense-budget-client-watch.module.js';
import { DefenseBudgetWatchAdapter } from './watch-actions/defense-budget-watch.adapter.js';
import { BizdevWatchAdapter } from './watch-actions/bizdev-watch.adapter.js';
import { ClientWatchlistAdapter } from './watch-actions/client-watchlist.adapter.js';
import { KeywordWatchAdapter } from './watch-actions/keyword-watch.adapter.js';
import { LegislativeComparisonController } from './legislative-comparison.controller.js';
import { ClientRecordActionController } from './client-record-action.controller.js';
import { ClientRecordActionService } from './client-record-action.service.js';
import { LegiwatchRelevanceController } from './legiwatch-relevance.controller.js';
import { LegiwatchRelevanceActionService } from './legiwatch-relevance-action.service.js';
import { LegiwatchReviewController } from './legiwatch-review.controller.js';
import { LegiwatchReviewService } from './legiwatch-review.service.js';
import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
import { Module } from '@nestjs/common';
import { ManagedMcpModule } from './managed-mcp.module.js';
import { ConfigService } from '@nestjs/config';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ClientDocumentsModule } from '../client-documents/client-documents.module.js';
import { MeriJobDeliverablesController } from './meri-job-deliverables.controller.js';
import { MeriCompletedReportsController } from './meri-completed-reports.controller.js';
import { MeriJobDeliverablesService } from './meri-job-deliverables.service.js';
import { AiCredentialsModule } from '../ai-credentials/ai-credentials.module.js';
// Phase 4 server-only slice: one-way import. BD exports the scope service;
// BD itself must NEVER import MeriModule (no reverse dependency).
import { BusinessDevelopmentModule } from '../business-development/business-development.module.js';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { LdaIntelModule } from '../lda-intel/lda-intel.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { FederalMarketMeriToolsService } from '../federal-spending/federal-market-meri-tools.service.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { ClientObjectivesModule } from '../clients/objectives/objectives.module.js';
import { AutomaticClientContextService } from './automatic-client-context.service.js';
import { RepresentationModule } from '../clients/representation.module.js';
import { RegulatoryDocketModule } from '../regulatory-docket/regulatory-docket.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { QualityTelemetryModule } from '../quality-telemetry/quality-telemetry.module.js';
import { EvaluationModule } from '../evaluation/evaluation.module.js';
import { EvaluationCaptureService } from '../evaluation/evaluation-capture.service.js';
import { ContextModule } from '../context/context.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { FundingOpportunitiesModule } from '../funding-opportunities/funding-opportunities.module.js';
import { ResearchPortfoliosModule } from '../research-portfolios/research-portfolios.module.js';
import { DistrictNexusModule } from '../district-nexus/district-nexus.module.js';
import { MeriOpportunityAssessmentService } from '../funding-opportunities/meri-opportunity-assessment.service.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriController } from './meri.controller.js';
import { ObjectiveJobController } from './objective-job.controller.js';
import { ConversationManagementController } from './conversation-management/controller.js';
import { HearingMediaController } from './hearing-media/controller.js';
import { ConversationRetentionController } from './conversation-management/retention.controller.js';
import { ObjectiveJobService } from './objective-job.service.js';
import { RetainedReadDispatcher } from './retained-read-dispatch.js';
import { MeriRoutineReadController, MeriRoutinesModule } from './routines/meri-routines.controller.js';
import { ObjectiveJobReadSources } from './objective-job-read-sources.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { ResearchPortfoliosService } from '../research-portfolios/research-portfolios.service.js';
import { ResearchPortfolioChangesService } from '../research-portfolios/research-portfolio-changes.service.js';
import { ResearchPortfolioReviewService } from '../research-portfolios/research-portfolio-review.service.js';
import { ResearchPortfolioAnalyticsService } from '../research-portfolios/research-portfolio-analytics.service.js';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { ToolServiceSecretGuard } from '../auth/tool-service-secret.guard.js';
import { GovernedMemoryCandidateService } from '../memory/governed-memory-candidate.service.js';
import { MeriMemoryHelperController } from './memory-receiving/meri-memory-helper.controller.js';
import { MeriSourceController } from './meri-source.controller.js';
import { MeriSourceService } from './meri-source.service.js';
import { MeriSkillsController } from './meri-skills.controller.js';
import { MeriActionProposalController } from './meri-action-proposal.controller.js';
import { MeriAnalysisArtifactController } from './meri-analysis-artifact.controller.js';
import { MeriContextPacketController } from './meri-context-packet.controller.js';
import { BizdevActionController } from './bizdev-action.controller.js';
import { BizdevActionService } from './bizdev-action.service.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { NoteActionController } from './note-action.controller.js';
import { NoteActionService } from './note-action.service.js';
import { LegiwatchActionController } from './legiwatch-action.controller.js';
import { LegiwatchActionService } from './legiwatch-action.service.js';
import { LegislativeDocumentActionController } from './legislative-document-action.controller.js';
import { LegislativeDocumentActionService } from './legislative-document-action.service.js';
import { WatchActionController } from './watch-actions/watch-action.controller.js';
import { WatchActionService } from './watch-actions/watch-action.service.js';
import { WatchActionRegistry } from './watch-actions/watch-action.registry.js';
import { MeriPolicyPackService } from './meri-policy-pack.service.js';
import { TenantCanariedMeriPolicyPackService } from './meri-policy-pack-rollout.service.js';
import { MeriPolicyPackController } from './meri-policy-pack.controller.js';
import { MeriService } from './meri.service.js';
import { MERI_TURN_MAINTENANCE } from './meri-turn-maintenance.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriBizDevToolsService } from './meri-bizdev-tools.service.js';
import { AnalyticsDbService } from './analytics/analytics-db.service.js';
import { PrivateSqlDbService } from './analytics/private-sql-db.service.js';
import { MeriPrivateSqlService } from './meri-private-sql.service.js';
import {
  createGovernedMeriToolsService,
  RAW_MERI_TOOLS_SERVICE,
} from './governed-meri-tools.proxy.js';
import { MeriResearchService } from './meri-research.service.js';
import { createGovernedMeriResearchService } from './governed-meri-research.factory.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { MeriMcpOAuthController } from './meri-mcp-oauth.controller.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriProcedureRuntimeValidationService } from './meri-procedure-runtime-validation.service.js';
import { MeriFeatureFlagsModule } from '../common/meri-feature-flags.module.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { MeriContextPlaneRuntimeService } from './meri-context-plane-runtime.js';
import { MeriV3ChatClient } from './meriv3-chat.client.js';
import { MeriV3ResearchRunner } from './meri-v3-research-runner.js';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { MeriConversationEvidenceService } from './meri-conversation-evidence.service.js';
import { MeriChatAttachmentReadService } from './meri-chat-attachment-read.service.js';
import { MeriV3SettingsController } from './meriv3-settings.controller.js';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';
import { MeriVNextLibraryController } from './meri-vnext-library.controller.js';
import { MeriVNextLibraryService } from './meri-vnext-library.service.js';
import { MeriJobLeaseSweeper } from './meri-job-lease-sweeper.js';
import { createMeriRuntimeService, RAW_MERI_SERVICE } from './meriv3-runtime.proxy.js';
import { MeriOtelLifecycleProvider } from './meri-otel-lifecycle.provider.js';

import { NativeApprovalModule } from './native-approvals/native-approval.controller.js';
import { ApplicationAuthorityModule } from '../auth/application-authority.module.js';
import { ContextSecurityScopeModule } from '../context/context-security-scope.module.js';
import { ConnectedAppReadService } from './connected-app-read.service.js';
import { ConnectedAppReadController } from './connected-app-read.controller.js';
import { SavedStrategyReadController } from './saved-strategy-read.controller.js';
import { SavedStrategyReadService } from './saved-strategy-read.service.js';
import { SavedRecordReadController } from './saved-record-read.controller.js';
import { SavedRecordReadService } from './saved-record-read.service.js';
import { MicrosoftGraphSyncService } from '../engagement/microsoft/microsoft-graph-sync.service.js';
@Module({
  imports: [
    ApplicationAuthorityModule,
    ContextSecurityScopeModule,
    NativeApprovalModule,
    MeriRoutinesModule,
    MeriFeatureFlagsModule,
    ManagedMcpModule,
    EngagementModule,
    ClientDocumentsModule,
    AiCredentialsModule,
    LdaIntelModule,
    LobbyIntelModule,
    FederalSpendingModule,
    ProgramElementModule,
    AcquisitionPersonnelModule,
    IntelligenceModule,
    ClientsModule,
    ClientObjectivesModule,
    RepresentationModule,
    RegulatoryDocketModule,
    EmbeddingsModule,
    MemoryModule,
    LearningModule,
    QualityTelemetryModule,
    EvaluationModule,
    ContextModule,
    RetrievalModule,
    ReviewsModule,
    FundingOpportunitiesModule,
    ResearchPortfoliosModule,
    // Phase 4 server-only slice: provides BizDevMeriScopeService for Meri
    // prospect conversation creation (one-way; BD never imports Meri).
    BusinessDevelopmentModule,
    DefenseBudgetClientWatchModule,
    DistrictNexusModule,
  ],
  controllers: [NoteActionController, LegislativeComparisonController, ClientRecordActionController,
    MeriRoutineReadController,
    ConversationManagementController,
    HearingMediaController,
    ConversationRetentionController,
    ObjectiveJobController,
    // Register the fixed signed callback before tools/:name in this module.
    MeriMemoryHelperController,
    ConnectedAppReadController,
    SavedRecordReadController,
    LegiwatchReviewController,
    LegiwatchRelevanceController,
    SavedStrategyReadController,
    LegiwatchActionController,
    BizdevActionController,
    LegislativeDocumentActionController,
    WatchActionController,
    MeriController,
    MeriSourceController,
    MeriSkillsController,
    MeriV3SettingsController,
    MeriAnalysisArtifactController,
    MeriActionProposalController,
    MeriContextPacketController,
    MeriPolicyPackController,
    MeriMcpOAuthController,
    MeriVNextLibraryController,
    MeriJobDeliverablesController,
    MeriCompletedReportsController,
  ],
  providers: [ClientRecordActionService,
    LegiwatchActionService,
    LegislativeDocumentActionService,
    WatchActionService,
    WatchActionRegistry,
    DefenseBudgetWatchAdapter,
    BizdevWatchAdapter,
    ClientWatchlistAdapter,
    KeywordWatchAdapter,
    NoteActionService,
    ConnectedAppReadService,
    SavedRecordReadService,
    LegiwatchReviewService,
    LegiwatchRelevanceActionService,
    SavedStrategyReadService,
    ToolServiceSecretGuard,
    AutomaticClientContextService,
    InternalServiceGuard,
    BizdevActionService,
    { provide: ObjectiveJobReadSources, useFactory: (integrations: EngagementService, tools: MeriToolsService,
      portfolios: ResearchPortfoliosService, changes: ResearchPortfolioChangesService,
      reviews: ResearchPortfolioReviewService, analytics: ResearchPortfolioAnalyticsService, connected: ConnectedAppReadService,
      teams: MicrosoftGraphSyncService) =>
      new ObjectiveJobReadSources(integrations, tools, portfolios, changes, reviews, analytics, connected, teams),
      inject: [EngagementService, MeriToolsService, ResearchPortfoliosService, ResearchPortfolioChangesService,
        ResearchPortfolioReviewService, ResearchPortfolioAnalyticsService, ConnectedAppReadService, MicrosoftGraphSyncService] },
    { provide: ObjectiveJobService, useFactory: (prisma: PrismaService, tools: MeriToolsService,
      memory: GovernedMemoryCandidateService, sources: ObjectiveJobReadSources) => new ObjectiveJobService(prisma, tools, memory, sources),
      inject: [PrismaService, MeriToolsService, GovernedMemoryCandidateService, ObjectiveJobReadSources] },
    { provide: RetainedReadDispatcher, useFactory: (prisma: PrismaService, tools: MeriToolsService,
      memory: GovernedMemoryCandidateService, sources: ObjectiveJobReadSources) => new RetainedReadDispatcher(prisma, tools, memory, sources),
      inject: [PrismaService, MeriToolsService, GovernedMemoryCandidateService, ObjectiveJobReadSources] },
    MeriJobDeliverablesService,
    MeriChatAttachmentReadService,
    MeriSourceService,
    MeriContextPlaneService,
    MeriContextPlaneRuntimeService,
    { provide: RAW_MERI_SERVICE, useClass: MeriService },
    { provide: MERI_TURN_MAINTENANCE, useExisting: RAW_MERI_SERVICE },
    MeriV3ChatClient,
    MeriV3ResearchRunner,
    MeriV3ProxyService,
    MeriConversationEvidenceService,

    {
      provide: MeriService,
      useFactory: createMeriRuntimeService,
      inject: [
        RAW_MERI_SERVICE,
        MeriV3ProxyService,
        MeriV3VisualAnalysisService,
        MeriContextPlaneRuntimeService,
      ],
    },
    AnalyticsDbService,
    PrivateSqlDbService,
    MeriPrivateSqlService,
    // Phase 4 — Meri business-development prospect tools. Optional in
    // MeriToolsService (one optional constructor param) so non-DI specs keep
    // constructing the tools service positionally without it.
    MeriBizDevToolsService,
    { provide: RAW_MERI_TOOLS_SERVICE, useClass: MeriToolsService },
    {
      provide: MeriToolsService,
      useFactory: createGovernedMeriToolsService,
      inject: [RAW_MERI_TOOLS_SERVICE, PrismaService, FederalMarketMeriToolsService],
    },
    {
      provide: MeriResearchService,
      useFactory: createGovernedMeriResearchService,
      inject: [
        PrismaService,
        ConfigService,
        MeriToolsService,
        AiCredentialResolverService,
        ReviewsService,
        MeriContextPlaneService,
        EvaluationCaptureService,
        MeriV3ResearchRunner,
        MERI_TURN_MAINTENANCE,
        MeriActionProposalService,
      ],
    },
    MeriDocgenService,
    MeriV3InternalServiceGuard,
    MeriV3VisualAnalysisService,
    MeriVNextLibraryService,
    // Stage 2 §5.2: reclaims expired job leases; dark unless MERI_JOB_SWEEPER_ENABLED=true.
    MeriJobLeaseSweeper,
    MeriFirmSkillsService,
    MeriProcedureRuntimeValidationService,
    MeriApprovalService,
    MeriActionProposalService,
    {
      provide: MeriPolicyPackService,
      useClass: TenantCanariedMeriPolicyPackService,
    },
    MeriComplianceAuditService,
    MeriClaimWriterService,
    {
      provide: 'FUNDING_OPPORTUNITY_ASSESSMENT_WIRING',
      useFactory: (
        assessment: MeriOpportunityAssessmentService,
        contextCompiler: ContextCompilerService,
        claimWriter: MeriClaimWriterService,
        auditor: MeriComplianceAuditService,
        aiCredentials: AiCredentialResolverService,
        config: ConfigService,
      ) =>
        assessment
          .withCollaborators({
            contextCompiler: contextCompiler as never,
            claimWriter,
            auditor,
          })
          .withCompletion(async (tenantId, system, user) => {
            const resolved = await aiCredentials.resolveProviderByTenantId(tenantId, 'anthropic');
            if (!resolved) throw new Error('ANTHROPIC_API_KEY not configured');
            const controller = new AbortController();
            const timer = setTimeout(
              () => controller.abort(),
              Number(config.get('CLIO_REQUEST_TIMEOUT_MS') ?? 60_000),
            );
            try {
              const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                  'x-api-key': resolved.apiKey,
                  'anthropic-version': '2023-06-01',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(
                  prepareAnthropicRequest({
                    model: config.get('CLIO_RESEARCH_PLAN_MODEL'),
                    max_tokens: 4000,
                    system,
                    messages: [{ role: 'user', content: user }],
                  }),
                ),
                signal: controller.signal,
              });
              if (!response.ok) {
                throw new Error(`Anthropic HTTP ${response.status}`);
              }
              const json = (await response.json()) as {
                content?: Array<{ type: string; text?: string }>;
              };
              return (json.content ?? [])
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('');
            } finally {
              clearTimeout(timer);
            }
          }),
      inject: [
        MeriOpportunityAssessmentService,
        ContextCompilerService,
        MeriClaimWriterService,
        MeriComplianceAuditService,
        AiCredentialResolverService,
        ConfigService,
      ],
    },
    MeriOtelLifecycleProvider,
  ],
  exports: [MeriToolsService, MeriFeatureFlagsModule],
})
export class MeriModule {}
