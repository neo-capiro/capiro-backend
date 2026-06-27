import { Module } from '@nestjs/common';
import { EditLockController } from './edit-lock.controller.js';
import { EditLockService } from './edit-lock.service.js';

@Module({
  controllers: [EditLockController],
  providers: [EditLockService],
  exports: [EditLockService],
})
export class EditLockModule {}
