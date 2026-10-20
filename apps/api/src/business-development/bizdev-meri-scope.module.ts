import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BizDevMeriScopeService } from './bizdev-meri-scope.service.js';

/** Existing prospect authority shared without dossier/model/ingestion owners. */
@Module({
  imports: [PrismaModule],
  providers: [BizDevMeriScopeService],
  exports: [BizDevMeriScopeService],
})
export class BizDevMeriScopeModule {}
