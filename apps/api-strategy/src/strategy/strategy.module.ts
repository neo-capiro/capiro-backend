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
import { PptxReportRenderer } from '../reports/pptx-report.renderer.js';
import { ReportSnapshotService } from '../reports/report-snapshot.service.js';
import { StrategyReportService } from '../reports/strategy-report.service.js';

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
    StrategyReportService,
    { provide: CLIENT_LOGO_READER, useClass: S3ClientLogoReader },
  ],
  // Stage C: AgentsModule's ChangeSet undo restores the pinned pre-apply version.
  exports: [VersionService],
})
export class StrategyModule {}
