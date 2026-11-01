import { Module } from '@nestjs/common';
import { ClientObjectivesController } from './objectives.controller.js';
import { ClientObjectivesService } from './objectives.service.js';
import { ObjectiveQuestionsController } from './questions/objective-questions.controller.js';
import { ObjectiveQuestionsService } from './questions/objective-questions.service.js';

@Module({
  controllers: [ClientObjectivesController, ObjectiveQuestionsController],
  providers: [ClientObjectivesService, ObjectiveQuestionsService],
  exports: [ClientObjectivesService],
})
export class ClientObjectivesModule {}
