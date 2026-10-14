import { Module } from '@nestjs/common';
import { TenantAdminController } from './tenant-admin.controller.js';
import { TenantAdminService } from './tenant-admin.service.js';

@Module({
  controllers: [TenantAdminController],
  providers: [TenantAdminService],
  exports: [TenantAdminService],
})
export class TenantAdminModule {}
