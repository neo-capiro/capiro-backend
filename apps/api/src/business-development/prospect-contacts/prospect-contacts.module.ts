import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BusinessDevelopmentFlagGuard } from '../business-development-flag.guard.js';
import { ProspectContactsController } from './prospect-contacts.controller.js';
import { ProspectContactsService } from './prospect-contacts.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [ProspectContactsController],
  providers: [ProspectContactsService, BusinessDevelopmentFlagGuard],
  exports: [ProspectContactsService],
})
export class ProspectContactsModule {}
