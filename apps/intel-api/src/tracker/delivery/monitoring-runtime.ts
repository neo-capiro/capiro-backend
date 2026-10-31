import { Phase8EvidenceService } from '../editorial/evidence.service.js';
import { EditorialService } from '../editorial/editorial.service.js';
import { runEditorialWork } from '../editorial/editorial-runtime.js';
import { ConfigService } from '@nestjs/config';
import { ResearchService } from '../research/research.service.js';
import { StatuteMonitorService } from '../research/statute-monitor.service.js';
import { KeywordSourceRepository } from '../../sourcedata/keyword-source.repository.js';
import { KeywordRuleService } from '../keywords/keyword-rule.service.js';
import { KeywordDeliveryService } from '../keywords/keyword-delivery.service.js';
import { KeywordDiscoveryService } from '../keywords/keyword-discovery.service.js';
import { InternalWorkflowService } from '../keywords/internal-workflow.service.js';
import { WorkflowTriggerService } from '../keywords/workflow-trigger.service.js';
import { CalendarPreparationService } from '../calendar/calendar-preparation.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  FeatureFlagService,
  FOLDER_TRACKER_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { FolderSourceDataRepository } from '../../sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../../sourcedata/source-data.repository.js';
import { IntelEmailService } from '../../intel-alert/intel-email.service.js';
import { FolderTrackerService } from '../folders/folder-tracker.service.js';
import { DraftAccessService } from './draft-access.service.js';
import { RecipientsService } from './recipients.service.js';
import { DeliveryService } from './delivery.service.js';
import { RecordRuleService } from './record-rule.service.js';
import { AgendaRuleService } from '../calendar/agenda-rule.service.js';
import { HearingPublicationService } from '../../hearing/hearing-publication.service.js';
import { HearingSessionService } from '../../hearing/hearing-session.service.js';
import { HearingCryptoService } from '../../hearing/hearing-crypto.service.js';
import { SmsService } from '../sms/sms.service.js';
import { HearingRecordWorkflowService } from '../../hearing/hearing-record-workflow.service.js';
import { HearingRecordDeliveryService } from '../../hearing/hearing-record-delivery.service.js';
import { HearingRecordsRepository } from '../../sourcedata/hearing-records.repository.js';
import { OrchestratorClient } from '../../hearing/orchestrator.client.js';
import { HearingAiCredentialResolver } from '../../hearing/hearing-ai-credential-resolver.client.js';
import { ClientBriefContextClient } from '../../hearing/client-brief-context.client.js';

export function monitoringRuntime(prisma: PrismaService) {
  const folders = new FolderTrackerService(
    prisma,
    new FolderSourceDataRepository(prisma),
    new SourceDataRepository(prisma),
  );
  const reports = new DraftAccessService(
    folders,
    new FeatureFlagService(prisma, new ConfigService()),
  );
  const recipients = new RecipientsService(reports);
  const publications = new HearingPublicationService(
    reports,
    recipients,
    new HearingSessionService(prisma),
    new HearingCryptoService(new ConfigService()),
  );
  const records = new HearingRecordWorkflowService(
    reports,
    new HearingRecordsRepository(prisma),
    new HearingCryptoService(new ConfigService()),
    publications,
    new OrchestratorClient(
      new ConfigService(),
      new HearingAiCredentialResolver(new ConfigService()),
    ),
    new ClientBriefContextClient(),
  );
  const recordDelivery = new HearingRecordDeliveryService(records, recipients);
  const keywordRules = new KeywordRuleService(reports, new KeywordSourceRepository(prisma));
  const keywordDelivery = new KeywordDeliveryService(keywordRules);
  const delivery = new DeliveryService(
    reports,
    recipients,
    new IntelEmailService(),
    publications,
    new SmsService(),
    recordDelivery,
    keywordDelivery,
  );
  const workflows = new InternalWorkflowService(
    new KeywordRuleService(reports, new KeywordSourceRepository(prisma)),
    new CalendarPreparationService(folders, reports.flags),
    records,
    new ResearchService(keywordRules),
  );
  return {
    editorialWork: (tenantId: string) =>
      runEditorialWork(
        new EditorialService(
          new Phase8EvidenceService(new ResearchService(keywordRules)),
          recipients,
          delivery,
        ),
        tenantId,
      ),
    statuteMonitors: new StatuteMonitorService(new ResearchService(keywordRules)),
    keywords: new KeywordDiscoveryService(
      new KeywordRuleService(reports, new KeywordSourceRepository(prisma)),
    ),
    workflows,
    workflowTriggers: new WorkflowTriggerService(workflows),
    keywordDelivery,
    reports,
    recipients,
    delivery,
    publications,
    records,
    recordDelivery,
    rules: new RecordRuleService(reports),
    agendaRules: new AgendaRuleService(reports),
  };
}
export async function monitoringTenants(prisma: PrismaService) {
  return prisma.withSystem((tx) =>
    tx.featureFlag.findMany({
      where: { feature: FOLDER_TRACKER_FEATURE, enabled: true },
      select: { tenantId: true },
    }),
  );
}
