import { Module } from '@nestjs/common';
import { GovernmentForecastsController } from './government-forecasts.controller.js';
import { GovernmentForecastsService } from './government-forecasts.service.js';

@Module({ controllers: [GovernmentForecastsController], providers: [GovernmentForecastsService] })
export class GovernmentForecastsModule {}
