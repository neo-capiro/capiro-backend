import { Global, Module } from '@nestjs/common';
import { ClerkService } from './clerk.service.js';
import { ClerkProvisioningService } from './clerk-provisioning.service.js';
import { IdentityOutboxService } from './identity-outbox.service.js';
import { InternalServiceGuard } from './internal-service.guard.js';
import { RolesGuard } from './roles.guard.js';

/**
 * Global authentication/authorization services. InternalServiceGuard is
 * exported so backend-only controllers in Context Plane, Workspace, Intel and
 * other feature modules resolve the same fail-closed shared-secret guard rather
 * than relying on implicit class construction.
 */
@Global()
@Module({
  providers: [
    ClerkService,
    ClerkProvisioningService,
    IdentityOutboxService,
    InternalServiceGuard,
    RolesGuard,
  ],
  exports: [
    ClerkService,
    ClerkProvisioningService,
    IdentityOutboxService,
    InternalServiceGuard,
    RolesGuard,
  ],
})
export class AuthModule {}
