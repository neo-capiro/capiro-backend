import { Global, Module } from '@nestjs/common';
import { ClerkService } from './clerk.service.js';
import { TenantGuard } from './tenant.guard.js';

@Global()
@Module({
  providers: [ClerkService, TenantGuard],
  exports: [ClerkService, TenantGuard],
})
export class AuthModule {}
