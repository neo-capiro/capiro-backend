import { Module } from '@nestjs/common';
import { EditLockController } from './edit-lock.controller.js';
import { EditLockService } from './edit-lock.service.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [CollaboratorsModule],
  controllers: [EditLockController],
  providers: [EditLockService],
  exports: [EditLockService],
})
export class EditLockModule {}
