import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ContextCompilerService } from './context-compiler.service.js';

/**
 * Context Compiler v1 (G1). Exports the ONE steering-context loader for every
 * apps/api Meri surface — imported by MeriModule (legacy chat/research),
 * EngagementModule (outreach) and IntelligenceModule (alert-memo /
 * district-brief) so none of them hand-rolls a memory_items loader again.
 */
@Module({
  imports: [PrismaModule],
  providers: [ContextCompilerService],
  exports: [ContextCompilerService],
})
export class ContextModule {}
