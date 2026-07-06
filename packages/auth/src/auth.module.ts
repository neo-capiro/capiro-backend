import { Global, Module } from '@nestjs/common';
import { ClerkService } from './clerk.service';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({
  providers: [ClerkService, TenantGuard],
  exports: [ClerkService, TenantGuard],
})
export class AuthModule {}
