import { Controller, Header, HttpCode, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { meriReadDelegationRawBodyOf } from '../../auth/read-delegation/read-delegation-request.js';
import { signedMemoryPageEnabled } from '../../auth/read-delegation/signed-memory-http-gate.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { consumeTaskBoundMemoryHelper } from './meri-memory-helper-receiver.js';

/** Fixed child-token callback, registered before MeriController's dynamic
 * `tools/:name` in the same module. Its distinct JWT never passes through the
 * ordinary read-token parser or Clerk. This source route remains hard off. */
@Controller('clio/tools')
@UseGuards(ToolServiceSecretGuard)
export class MeriMemoryHelperController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('search_memory_eligibility')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  eligibility(@Req() req: Request) {
    if (!signedMemoryPageEnabled()) throw new ServiceUnavailableException('Passive memory helper unavailable');
    const rawBody = meriReadDelegationRawBodyOf(req);
    return consumeTaskBoundMemoryHelper(this.prisma, req, rawBody ?? Buffer.alloc(0), process.env, { enabled: true });
  }
}
