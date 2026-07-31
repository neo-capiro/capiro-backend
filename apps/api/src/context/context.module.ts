import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ContextCompilerService } from './context-compiler.service.js';
import { ContextPersistenceBoundaryInterceptor } from './context-persistence-boundary.interceptor.js';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';

/**
 * One Context Compiler plus one request-local release boundary for every apps/api
 * Meri surface. The boundary is global so a legacy fail-soft caller cannot hide a
 * required Context Packet persistence failure and still release a deliverable.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ContextPersistenceBoundaryService,
    ContextCompilerService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ContextPersistenceBoundaryInterceptor,
    },
  ],
  exports: [ContextCompilerService, ContextPersistenceBoundaryService],
})
export class ContextModule {}
