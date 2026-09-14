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
  REPORTS_UPDATES_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { FolderSourceDataRepository } from '../../sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../../sourcedata/source-data.repository.js';
import { IntelEmailService } from '../../intel-alert/intel-email.service.js';
import { FolderTrackerService } from '../folders/folder-tracker.service.js';
import { ReportService } from './report.service.js';
import { ReportRecipientsService } from './recipients.service.js';
import { ReportDeliveryService } from './report-delivery.service.js';
import { ReportSubscriptionService } from './report-subscription.service.js';
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

export function reportRuntime(prisma: PrismaService) {
  const folders = new FolderTrackerService(
    prisma,
    new FolderSourceDataRepository(prisma),
    new SourceDataRepository(prisma),
  );
  const reports = new ReportService(folders, new FeatureFlagService(prisma, new ConfigService()));
  const recipients = new ReportRecipientsService(reports);
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
  const delivery = new ReportDeliveryService(
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
    subscriptions: new ReportSubscriptionService(reports, recipients, delivery),
    rules: new RecordRuleService(reports),
    agendaRules: new AgendaRuleService(reports),
  };
}
export async function reportTenants(prisma: PrismaService) {
  return prisma.withSystem((tx) =>
    tx.featureFlag.findMany({
      where: { feature: REPORTS_UPDATES_FEATURE, enabled: true },
      select: { tenantId: true },
    }),
  );
}

/** Controlled internal qualification: public canonical facts, the operator's
 * own folder, a draft-only schedule and no delivery recipients. */
export async function prepareReportDraftQualification(
  prisma: PrismaService,
  tenantId: string,
  actor: string,
  billId: string,
) {
  if (!tenantId || !actor || !billId)
    throw new Error('tenant UUID, current staff Clerk ID and canonical bill ID are required');
  const tenant = await prisma.withSystem(
    (tx) =>
      tx.$queryRaw<Array<{ slug: string }>>`SELECT slug FROM tenants WHERE id=${tenantId}::uuid`,
  );
  if (tenant[0]?.slug !== 'capiro-internal')
    throw new Error('Qualification fixtures are restricted to the internal workspace');
  const runtime = reportRuntime(prisma),
    ctx = { tenantId, clerkUserId: actor, role: null };
  await runtime.reports.authorize(ctx);
  const [bill] = await runtime.reports.folders.source.reportBills([billId]);
  if (
    !bill ||
    bill.sourceCheckStatus !== 'success' ||
    !bill.coverage.actions ||
    !bill.sourceCheckedAt ||
    Date.now() - Date.parse(bill.sourceCheckedAt) > 86400000
  )
    throw new Error(
      'Fresh canonical source coverage required before creating the qualification draft',
    );
  const name = 'Phase 2 · controlled draft qualification';
  const folder =
    (await runtime.reports.folders.list(ctx)).find(
      (f) => f.name === name && f.ownerClerkId === actor && !f.archived,
    ) ??
    (await runtime.reports.folders.create(ctx, {
      name,
      jurisdiction: bill.jurisdiction,
      defaultSession: bill.sessionKey,
    }));
  await runtime.reports.folders.bulk(ctx, folder.id, { action: 'add', billIds: [billId] });
  const report =
    (await runtime.reports.list(ctx)).find((r) => r.name === name && r.ownerClerkId === actor) ??
    (await runtime.reports.save(ctx, {
      name,
      folderIds: [folder.id],
      jurisdiction: bill.jurisdiction,
      sessionKey: bill.sessionKey,
      settings: { committees: 'off', actions: 'five_days', summary: true },
    }));
  const existing = (await runtime.subscriptions.list(ctx)).find(
    (s) => s.reportId === report.id && s.enabled,
  );
  if (existing)
    return {
      folderId: folder.id,
      reportId: report.id,
      subscriptionId: existing.id,
      nextDueAt: existing.nextDueAt,
      mode: existing.mode,
      reused: true,
    };
  const now = new Date(),
    cutoff = new Date(now.getTime() + 120000);
  const sub = await runtime.subscriptions.save(ctx, {
    reportId: report.id,
    mode: 'draft',
    timezone: 'UTC',
    localMinutes: cutoff.getUTCHours() * 60 + cutoff.getUTCMinutes(),
    subject: name,
    selection: [],
    sendNoChange: true,
  });
  const active = await runtime.subscriptions.activation(ctx, sub.id, {
    enabled: true,
    expectedVersion: sub.version,
  });
  return {
    folderId: folder.id,
    reportId: report.id,
    subscriptionId: active.id,
    nextDueAt: active.nextDueAt,
    mode: 'draft',
    recipients: 0,
  };
}
