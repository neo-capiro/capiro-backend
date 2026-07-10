import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { RepresentationModule } from '../../clients/representation.module.js';
import { ChokepointController } from './chokepoint.controller.js';
import { ChokepointService } from './chokepoint.service.js';

/**
 * Committee Chokepoint (Phase 1 M2.4). Depends only on PrismaModule (the
 * global congress and state tables) + RepresentationModule (M1.3's
 * deterministic resolver, reused for footprintOverlap — PD2/PD7: one
 * resolver everywhere).
 */
@Module({
  imports: [PrismaModule, RepresentationModule],
  controllers: [ChokepointController],
  providers: [ChokepointService],
  exports: [ChokepointService],
})
export class ChokepointModule {}
