import { Module } from '@nestjs/common';
import { DirectoryController } from './directory.controller.js';
import { InternalDirectoryController } from './internal-directory.controller.js';
import { DirectoryService } from './directory.service.js';
import { RepresentationModule } from '../clients/representation.module.js';

@Module({
  // District Impact Engine (Phase 1 M1.4) — the "Represents client
  // facilities" pill needs RepresentationResolverService's tenant-wide
  // facility scan.
  imports: [RepresentationModule],
  // InternalDirectoryController: backend-only bridge for apps/workspace's
  // Hill Day attendee resolution (InternalServiceGuard, read-only).
  controllers: [DirectoryController, InternalDirectoryController],
  providers: [DirectoryService],
  exports: [DirectoryService],
})
export class DirectoryModule {}
