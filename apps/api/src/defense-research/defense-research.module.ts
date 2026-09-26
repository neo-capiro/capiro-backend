import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DefenseResearchController } from './defense-research.controller.js';
import { DefenseResearchService } from './defense-research.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [DefenseResearchController],
  providers: [DefenseResearchService],
  exports: [DefenseResearchService],
})
export class DefenseResearchModule {}
