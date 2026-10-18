import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ContextSecurityScopeService } from './context-security-scope.service.js';

/** Current client/wall authority without context compilation or retrieval. */
@Module({
  imports: [PrismaModule],
  providers: [ContextSecurityScopeService],
  exports: [ContextSecurityScopeService],
})
export class ContextSecurityScopeModule {}
