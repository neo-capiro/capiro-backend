import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { PortfolioLayoutController } from './portfolio-layout.controller.js';
import { ApplicationAuthorityModule } from '../auth/application-authority.module.js';

@Module({
  imports: [ApplicationAuthorityModule],
  controllers: [UsersController, PortfolioLayoutController],
})
export class UsersModule {}
