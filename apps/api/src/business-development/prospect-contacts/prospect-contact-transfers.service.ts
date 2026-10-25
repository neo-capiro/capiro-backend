import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientKbService } from '../../embeddings/client-kb.service.js';
import { commitContactTransfer, readContactTransfer } from './prospect-contact-transfer-command.js';

@Injectable()
export class ProspectContactTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientKb: ClientKbService,
  ) {}
  async transfer(ctx: TenantContext, prospectId: string, raw: unknown) {
    const outcome = await commitContactTransfer(this.prisma, ctx, prospectId, raw);
    for (const personId of outcome.createdIds)
      this.clientKb.indexPersonFireAndForget(ctx.tenantId, personId);
    return outcome.receipt;
  }
  receipt(ctx: TenantContext, prospectId: string, requestId: string) {
    return readContactTransfer(this.prisma, ctx, prospectId, requestId);
  }
}
