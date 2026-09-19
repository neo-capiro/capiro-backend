import { Module } from '@nestjs/common';
import { StrategyController } from './strategy.controller.js';
import { StrategyService } from './strategy.service.js';
import { NodeService } from './node.service.js';
import { VersionService } from './version.service.js';
import { VersioningService } from './versioning.service.js';
import {
  CLIENT_LOGO_READER,
  S3ClientLogoReader,
} from '../reports/client-logo.reader.js';
import { DocxReportRenderer } from '../reports/docx-report.renderer.js';
import {
  DirectoryMemberOfficeReader,
  MEMBER_OFFICE_READER,
} from '../reports/member-office.reader.js';
import { PptxReportRenderer } from '../reports/pptx-report.renderer.js';
import { PdfBrowserDriver } from '../reports/pdf-browser.driver.js';
import { PdfReportRenderer } from '../reports/pdf-report.renderer.js';
import { ReportNarrativeService } from '../reports/report-narrative.service.js';
import { ReportSnapshotService } from '../reports/report-snapshot.service.js';
import { StrategyReportService } from '../reports/strategy-report.service.js';
import { StrategyAiCredentialResolver } from '../meri/strategy-ai-credential.resolver.js';
import { StrategyOrchestratorClient } from '../meri/strategy-orchestrator.client.js';

@Module({
  controllers: [StrategyController],
  providers: [
    StrategyService,
    NodeService,
    VersionService,
    VersioningService,
    ReportSnapshotService,
    DocxReportRenderer,
    PptxReportRenderer,
    PdfBrowserDriver,
    PdfReportRenderer,
    StrategyReportService,
    ReportNarrativeService,
    // The report narrative reuses Meri's orchestrator transport and BYOK
    // credential resolver. Both depend only on ConfigService, so providing them
    // here (a second, independent instance) avoids coupling StrategyModule to
    // MeriModule's governed Context Plane wiring.
    StrategyOrchestratorClient,
    StrategyAiCredentialResolver,
    { provide: CLIENT_LOGO_READER, useClass: S3ClientLogoReader },
    { provide: MEMBER_OFFICE_READER, useClass: DirectoryMemberOfficeReader },
  ],
  // Stage C: AgentsModule's ChangeSet undo restores the pinned pre-apply version.
  exports: [VersionService],
})
export class StrategyModule {}
