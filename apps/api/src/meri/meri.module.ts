import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
import { Module } from '@nestjs/common';
import { ManagedMcpModule } from './managed-mcp.module.js';
import { ConfigService } from '@nestjs/config';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ClientDocumentsModule } from '../client-documents/client-documents.module.js';
import { MeriClientFilingService } from './meri-client-filing.service.js';
import { AiCredentialsModule } from '../ai-credentials/ai-credentials.module.js';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { LdaIntelModule } from '../lda-intel/lda-intel.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { FederalMarketMeriToolsService } from '../federal-spending/federal-market-meri-tools.service.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ClientsModule } from '../clients/clients.module.js';
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
import { DistrictNexusModule } from '../district-nexus/district-nexus.module.js';
import { MeriOpportunityAssessmentService } from '../funding-opportunities/meri-opportunity-assessment.service.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriController } from './meri.controller.js';
import { MeriSourceController } from './meri-source.controller.js';
import { MeriSourceService } from './meri-source.service.js';
import { MeriSkillsController } from './meri-skills.controller.js';
import { MeriActionProposalController } from './meri-action-proposal.controller.js';
import { MeriAnalysisArtifactController } from './meri-analysis-artifact.controller.js';
import { MeriContextPacketController } from './meri-context-packet.controller.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { MeriPolicyPackService } from './meri-policy-pack.service.js';
import { TenantCanariedMeriPolicyPackService } from './meri-policy-pack-rollout.service.js';
import { MeriPolicyPackController } from './meri-policy-pack.controller.js';
import { MeriFeedbackFixtureService } from './meri-feedback-fixture.service.js';
import { MeriService } from './meri.service.js';
import { MERI_TURN_MAINTENANCE } from './meri-turn-maintenance.js';
import { MeriToolsService } from './meri-tools.service.js';
import { AnalyticsDbService } from './analytics/analytics-db.service.js';
import {
  createGovernedMeriToolsService,
  RAW_MERI_TOOLS_SERVICE,
} from './governed-meri-tools.proxy.js';
import { MeriResearchService } from './meri-research.service.js';
import { createGovernedMeriResearchService } from './governed-meri-research.factory.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpOAuthController } from './meri-mcp-oauth.controller.js';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { MeriContextPlaneRuntimeService } from './meri-context-plane-runtime.js';
import { MeriV2ChatClient } from './meriv2-chat.client.js';
import { MeriV3ChatClient } from './meriv3-chat.client.js';
import { MeriV3ResearchRunner } from './meri-v3-research-runner.js';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { MeriConversationEvidenceService } from './meri-conversation-evidence.service.js';
import { MeriV3SettingsController } from './meriv3-settings.controller.js';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';
import { MeriVNextLibraryController } from './meri-vnext-library.controller.js';
import { MeriVNextLibraryService } from './meri-vnext-library.service.js';
import { createMeriRuntimeService, RAW_MERI_SERVICE } from './meriv3-runtime.proxy.js';
import { MeriHermesRuntimeClient } from './hermes/meri-hermes-runtime.client.js';
import { MERI_HERMES_RUN_REPOSITORY, MeriHermesRunStore } from './hermes/meri-hermes-run-store.js';
import { MeriHermesPrismaRunRepository } from './hermes/meri-hermes-prisma-run-repository.js';
import { MeriHermesRuntimeAdapter } from './hermes/meri-hermes-runtime.adapter.js';
import { MeriHermesBrokerService } from './hermes/meri-hermes-broker.service.js';
import { MeriHermesDbGovernor, meriHermesSharedDbGovernor } from './hermes/meri-hermes-db-governor.js';
import { MeriHermesBudgetService } from './hermes/meri-hermes-budget.service.js';
import { MeriHermesAdmissionControlService } from './hermes/meri-hermes-admission-control.service.js';
import { MeriHermesProfileLeaseService } from './hermes/meri-hermes-profile-lease.service.js';
import { MeriHermesArtifactStorageService } from './hermes/meri-hermes-artifact-storage.service.js';
import {
  MeriHermesMaintenanceService,
  MeriHermesWorkerLifecycleService,
} from './hermes/meri-hermes-worker-lifecycle.service.js';
import { MERI_HERMES_WORKER_RESOLVER } from './hermes/meri-hermes-worker-resolver.port.js';
import {
  MeriHermesBrokerController,
  MeriHermesWorkerTokenGuard,
} from './hermes/meri-hermes-broker.controller.js';
import { MeriHermesController } from './hermes/meri-hermes.controller.js';
import {
  ContextPlaneRecallPort,
  MERI_HERMES_RECALL_PORT,
} from './hermes/meri-hermes-recall.ports.js';
import { MERI_HERMES_SECURITY_ENVELOPE } from './hermes/meri-hermes-security.port.js';

@Module({
  imports: [
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
    DistrictNexusModule,
  ],
  controllers: [
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
    // Phase 0 Hermes pilot surfaces (server-gated; 404 outside the pilot).
    MeriHermesController,
    MeriHermesBrokerController,
  ],
  providers: [
    MeriClientFilingService,
    MeriSourceService,
    MeriContextPlaneService,
    MeriContextPlaneRuntimeService,
    { provide: RAW_MERI_SERVICE, useClass: MeriService },
    { provide: MERI_TURN_MAINTENANCE, useExisting: RAW_MERI_SERVICE },
    MeriV3ChatClient,
    MeriV3ResearchRunner,
    MeriV3ProxyService,
    MeriConversationEvidenceService,
    // Hermes runtime: client, run repository (durable Prisma-backed, Phase 1
    // backlog #1) plus the in-memory MeriHermesRunStore test double, broker
    // and adapter. The adapter/broker/controllers depend on the
    // MERI_HERMES_RUN_REPOSITORY token, not the concrete class, so real
    // traffic is durable across API restarts while specs can still construct
    // MeriHermesRunStore directly.
    MeriHermesRuntimeClient,
    MeriHermesRunStore,
    { provide: MERI_HERMES_RUN_REPOSITORY, useClass: MeriHermesPrismaRunRepository },
    // Phase 1 backlog #2: on-demand worker provisioning. Bound to the client
    // by the MERI_HERMES_WORKER_RESOLVER token (not by concrete class) to
    // avoid a circular class dependency — see meri-hermes-worker-resolver.port.ts.
    MeriHermesWorkerLifecycleService,
    { provide: MERI_HERMES_WORKER_RESOLVER, useExisting: MeriHermesWorkerLifecycleService },
    { provide: MERI_HERMES_RECALL_PORT, useClass: ContextPlaneRecallPort },
    { provide: MERI_HERMES_SECURITY_ENVELOPE, useExisting: MeriContextPlaneService },
    MeriHermesArtifactStorageService,
    /**
     * Phase 1 scaling obligations S-1..S-4. The governor is bound to the
     * PROCESS-WIDE instance, not merely to a Nest singleton: its semaphore is
     * what bounds Hermes-attributable database concurrency to its declared
     * share of the API pool, and a per-consumer instance would bound nothing
     * (three consumers with six slots each is eighteen slots). The adapter and
     * the broker cannot receive it through DI — both are constructed
     * positionally by their specs, so their constructors are deliberately not
     * widened — and they reach the same object through
     * `meriHermesSharedDbGovernor()`. Binding the provider to that same
     * function is what keeps DI and non-DI consumers on one semaphore.
     */
    { provide: MeriHermesDbGovernor, useFactory: meriHermesSharedDbGovernor },
    MeriHermesBudgetService,
    MeriHermesAdmissionControlService,
    MeriHermesProfileLeaseService,
    MeriHermesBrokerService,
    MeriHermesWorkerTokenGuard,
    MeriHermesRuntimeAdapter,
    /**
     * Phase 1 required fix 2a: the background owner of crash recovery
     * (`takeOverStaleRuns`) and idle-worker reclamation (`sweepIdleWorkers`),
     * neither of which had any production caller. Registered here rather than
     * in `EngagementWorkersModule` because that module is explicitly the
     * owner of *Engagement* timers and is not loaded by every process that
     * serves Meri. Its own guards (NODE_ENV, HTTP adapter presence,
     * MERI_HERMES_MAINTENANCE_ENABLED) decide whether it actually starts —
     * see the class doc.
     */
    MeriHermesMaintenanceService,
    {
      provide: MeriService,
      useFactory: createMeriRuntimeService,
      inject: [
        RAW_MERI_SERVICE,
        MeriV3ProxyService,
        MeriV3VisualAnalysisService,
        MeriContextPlaneRuntimeService,
        MeriHermesRuntimeAdapter,
      ],
    },
    AnalyticsDbService,
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
      ],
    },
    MeriDocgenService,
    MeriV3InternalServiceGuard,
    MeriV3VisualAnalysisService,
    MeriVNextLibraryService,
    MeriFirmSkillsService,
    MeriFeatureFlagsService,
    MeriApprovalService,
    MeriActionProposalService,
    {
      provide: MeriPolicyPackService,
      useClass: TenantCanariedMeriPolicyPackService,
    },
    MeriFeedbackFixtureService,
    MeriComplianceAuditService,
    MeriClaimWriterService,
    MeriV2ChatClient,
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
                body: JSON.stringify(prepareAnthropicRequest({
                  model: config.get('CLIO_RESEARCH_PLAN_MODEL'),
                  max_tokens: 4000,
                  system,
                  messages: [{ role: 'user', content: user }],
                })),
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
  ],
  exports: [
    MeriToolsService,
    MeriFeatureFlagsService,
    MeriHermesRuntimeAdapter,
    MERI_HERMES_RUN_REPOSITORY,
    MERI_HERMES_SECURITY_ENVELOPE,
  ],
})
export class MeriModule {}
