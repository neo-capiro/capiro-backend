import { Module, ServiceUnavailableException } from '@nestjs/common';
import { AuthModule } from './auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RetainedReadAuthorityController } from './retained-read-authority.controller.js';
import {
  RetainedReadAuthorityService,
  type RetainedFloridaAuthorityPort,
} from './retained-read-authority.service.js';
import {
  RETAINED_FLORIDA_AUTHORITY,
  RETAINED_READ_SOURCE_ENABLED,
} from './retained-read-authority.js';

/** Intentionally not imported by AppModule. No issuer, verifier or live route is installed. */
@Module({
  imports: [AuthModule, TenantModule, PrismaModule],
  controllers: [RetainedReadAuthorityController],
  providers: [
    RetainedReadAuthorityService,
    { provide: RETAINED_READ_SOURCE_ENABLED, useValue: false },
    {
      provide: RETAINED_FLORIDA_AUTHORITY,
      useValue: {
        async read() {
          throw new ServiceUnavailableException(
            'Retained Florida issuer/verifier unavailable',
          );
        },
      } satisfies RetainedFloridaAuthorityPort,
    },
  ],
  exports: [RetainedReadAuthorityService],
})
export class RetainedReadAuthorityModule {}
