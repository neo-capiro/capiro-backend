import { Global, Module } from '@nestjs/common';
import { ClerkService } from './clerk.service.js';
import { ClerkProvisioningService } from './clerk-provisioning.service.js';
import { IdentityOutboxService } from './identity-outbox.service.js';
import { RolesGuard } from './roles.guard.js';

@Global()
@Module({
  providers: [ClerkService, ClerkProvisioningService, IdentityOutboxService, RolesGuard],
  exports: [ClerkService, ClerkProvisioningService, IdentityOutboxService, RolesGuard],
})
export class AuthModule {}
