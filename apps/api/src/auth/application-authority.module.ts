import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ContextSecurityScopeModule } from '../context/context-security-scope.module.js';
import { BizDevMeriScopeModule } from '../business-development/bizdev-meri-scope.module.js';
import { AuthModule } from './auth.module.js';
import { ApplicationAuthorityController } from './application-authority.controller.js';
import { ApplicationMembershipController } from './application-membership.controller.js';
import { ApplicationMembershipService } from './application-membership.service.js';

@Module({
  imports: [AuthModule, TenantModule, PrismaModule, ContextSecurityScopeModule, BizDevMeriScopeModule],
  controllers: [ApplicationAuthorityController, ApplicationMembershipController],
  providers: [ApplicationMembershipService],
})
export class ApplicationAuthorityModule {}
