import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { PortfolioLayoutController } from './portfolio-layout.controller.js';

@Module({
  controllers: [UsersController, PortfolioLayoutController],
})
export class UsersModule {}
