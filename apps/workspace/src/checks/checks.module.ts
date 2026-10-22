import { Module } from '@nestjs/common';
import { ChecksController } from './checks.controller.js';
import { ChecksService } from './checks.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [ChecksController],
  providers: [ChecksService],
  exports: [ChecksService],
})
export class ChecksModule {}
