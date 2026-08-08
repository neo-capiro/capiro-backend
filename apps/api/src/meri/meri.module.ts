import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EngagementModule } from '../engagement/engagement.module.js';
import { AiCredentialsModule } from '../ai-credentials/ai-credentials.module.js';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { LdaIntelModule } from '../lda-intel/lda-intel.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from '../acquisition-personnel/acquisition-personnel.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { RepresentationModule } from '../clients/representation.module.js';
import { RegulatoryDocketModule } from '../regulatory-docket/regulatory-docket.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ContextModule } from '../context/context.module.js';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { FundingOpportunitiesModule } from '../funding-opportunities/funding-opportunities.module.js';
import { MeriOpportunityAssessmentService } from '../funding-opportunities/meri-opportunity-assessment.service.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriController } from './meri.controller.js';
import { MeriActionProposalController } from './meri-action-proposal.controller.js';
import { MeriContextPacketController } from './meri-context-packet.controller.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { MeriPolicyPackService } from './meri-policy-pack.service.js';
import { TenantCanariedMeriPolicyPackService } from './meri-policy-pack-rollout.service.js';
import { MeriPolicyPackController } from './meri-policy-pack.controller.js';
import { MeriFeedbackFixtureService } from './meri-feedback-fixture.service.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
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
import { MeriV2ChatClient } from './meriv2-chat.client.js';
import { MeriV3ChatClient } from './meriv3-chat.client.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { MeriV3SettingsController } from './meriv3-settings.controller.js';
import {
  createMeriRuntimeService,
  RAW_MERI_SERVICE,
} from './meriv3-runtime.proxy.js';

@Module({
  imports: [
    EngagementModule,
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
    ContextModule,
    ReviewsModule,
    FundingOpportunitiesModule,
  ],
  controllers: [
    MeriController,
    MeriV3SettingsController,
    MeriActionProposalController,
    MeriContextPacketController,
    MeriPolicyPackController,
    MeriMcpOAuthController,
  ],
  providers: [
    { provide: RAW_MERI_SERVICE, useClass: MeriService },
    MeriV3ChatClient,
    MeriV3ProxyService,
    {
      provide: MeriService,
      useFactory: createMeriRuntimeService,
      inject: [RAW_MERI_SERVICE, MeriV3ProxyService],
    },
    { provide: RAW_MERI_TOOLS_SERVICE, useClass: MeriToolsService },
    {
      provide: MeriToolsService,
      useFactory: createGovernedMeriToolsService,
      inject: [RAW_MERI_TOOLS_SERVICE],
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
        ContextCompilerService,
      ],
    },
    MeriDocgenService,
    MeriMcpService,
    MeriMcpOAuthService,
    MeriManagedMcpService,
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
                body: JSON.stringify({
                  model: config.get('CLIO_RESEARCH_PLAN_MODEL'),
                  max_tokens: 4000,
                  system,
                  messages: [{ role: 'user', content: user }],
                }),
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
  exports: [MeriToolsService, MeriFeatureFlagsService],
})
export class MeriModule {}
