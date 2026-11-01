import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { DbLaneMiddleware } from './db-lane.middleware.js';

@Global()
@Module({
  providers: [PrismaService, DbLaneMiddleware],
  exports: [PrismaService, DbLaneMiddleware],
})
export class PrismaModule {}
