import { Module } from '@nestjs/common';
import { ClientObjectivesController } from './objectives.controller.js';
import { ClientObjectivesService } from './objectives.service.js';
import { ObjectiveQuestionsController } from './questions/objective-questions.controller.js';
import { ObjectiveQuestionsService } from './questions/objective-questions.service.js';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { ObjectiveEvidenceSourceService } from './evidence/objective-evidence-source.service.js';

@Module({
  imports: [EngagementModule],
  controllers: [ClientObjectivesController, ObjectiveQuestionsController],
  providers: [ClientObjectivesService, ObjectiveQuestionsService, ObjectiveEvidenceSourceService],
  exports: [ClientObjectivesService],
})
export class ClientObjectivesModule {}
