import { Module } from '@nestjs/common';
import { ProgramElementModule } from '../program-element/program-element.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { WorkspaceTableController } from './workspace-table.controller.js';
import { WorkspaceTableService } from './workspace-table.service.js';

/**
 * Pull-from-platform tables for the Workspace editor. Reuses the typed PE,
 * intelligence (tracked bills), and client capability/facility services to
 * build { title, headers, rows } tables on demand.
 */
@Module({
  imports: [ProgramElementModule, IntelligenceModule, ClientsModule],
  controllers: [WorkspaceTableController],
  providers: [WorkspaceTableService],
})
export class WorkspaceTableModule {}
