import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EngagementRuntimeModule } from '../engagement/runtime/engagement-runtime.module.js';
import { AiCredentialResolverService } from './ai-credential-resolver.service.js';
import { InternalAiCredentialsController } from './internal-ai-credentials.controller.js';

/** Neutral shared AI credential boundary for all Capiro reasoning consumers. */
@Module({
  imports: [PrismaModule, EngagementRuntimeModule],
  controllers: [InternalAiCredentialsController],
  providers: [AiCredentialResolverService],
  exports: [AiCredentialResolverService],
})
export class AiCredentialsModule {}
