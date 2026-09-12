import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';

/** Controller-free shared connector runtime; does not import Meri's chat surface. */
@Module({
  imports: [PrismaModule],
  providers: [MeriMcpService, MeriMcpOAuthService, MeriManagedMcpService],
  exports: [MeriMcpService, MeriMcpOAuthService, MeriManagedMcpService],
})
export class ManagedMcpModule {}
