import { Module } from '@nestjs/common';
import { ClientObjectivesController } from './objectives.controller.js';
import { ClientObjectivesService } from './objectives.service.js';

@Module({ controllers: [ClientObjectivesController], providers: [ClientObjectivesService] })
export class ClientObjectivesModule {}
