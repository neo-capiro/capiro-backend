import { Module } from '@nestjs/common';
import { DirectoryController } from './directory.controller.js';
import { DirectoryService } from './directory.service.js';
import { RepresentationModule } from '../clients/representation.module.js';

@Module({
  // District Impact Engine (Phase 1 M1.4) — the "Represents client
  // facilities" pill needs RepresentationResolverService's tenant-wide
  // facility scan.
  imports: [RepresentationModule],
  controllers: [DirectoryController],
  providers: [DirectoryService],
  exports: [DirectoryService],
})
export class DirectoryModule {}
