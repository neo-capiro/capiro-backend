import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RetainedReadAuthorityController } from './retained-read-authority.controller.js';
import { RetainedReadAuthorityService } from './retained-read-authority.service.js';
import {
  RETAINED_FLORIDA_AUTHORITY,
  RETAINED_READ_SOURCE_ENABLED,
} from './retained-read-authority.js';
import {
  RETAINED_TRUST,
  RetainedTrustModule,
  createRetainedFloridaAuthorityPort,
} from './retained-trust.js';

/** Mounted through RetainedPrincipalModule. Inert (source disabled, Florida 503) unless
 * RETAINED_READS_ENABLED=true with a complete validated trust pin set. */
@Module({
  imports: [AuthModule, TenantModule, PrismaModule, RetainedTrustModule],
  controllers: [RetainedReadAuthorityController],
  providers: [
    RetainedReadAuthorityService,
    { provide: RETAINED_READ_SOURCE_ENABLED, useFactory: (trust: unknown) => trust !== null, inject: [RETAINED_TRUST] },
    { provide: RETAINED_FLORIDA_AUTHORITY, useFactory: createRetainedFloridaAuthorityPort, inject: [RETAINED_TRUST] },
  ],
  exports: [RetainedReadAuthorityService],
})
export class RetainedReadAuthorityModule {}
