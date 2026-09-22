import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ExplorerController } from './explorer.controller.js';
import { ExplorerService } from './explorer.service.js';
import { NewsEvidenceService } from '../intelligence/news/news-evidence.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [ExplorerController],
  providers: [ExplorerService, NewsEvidenceService],
})
export class ExplorerModule {}
