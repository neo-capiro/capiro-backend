import { Module } from '@nestjs/common';
import { ItAdminController } from './it-admin.controller.js';
import { ItAdminService } from './it-admin.service.js';

/**
 * IT-admin org-wide email-grant path (Microsoft admin-consent; Google
 * deferred per decision Q5). Tokened single-task surface — no Clerk account.
 */
@Module({
  controllers: [ItAdminController],
  providers: [ItAdminService],
})
export class ItAdminModule {}
