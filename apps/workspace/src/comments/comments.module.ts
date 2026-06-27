import { Module } from '@nestjs/common';
import { CommentsController } from './comments.controller.js';
import { CommentsService } from './comments.service.js';
import { GenerationModule } from '../generation/generation.module.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';

@Module({
  imports: [GenerationModule, CollaboratorsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
