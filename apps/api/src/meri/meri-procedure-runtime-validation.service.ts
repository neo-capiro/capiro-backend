import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { resolveCurrentServedProcedure } from './meri-procedure-runtime.js';
import type { MeriProcedureScope } from './skills/skill.types.js';

export interface ValidateMeriProcedureRuntimeInput {
  conversationId: string;
  clientId: string | null;
  scope: MeriProcedureScope;
  recordId: string;
  canonicalId: string;
  procedureVersion: number;
  manifestDigest: string;
  toolName: string;
}

export interface MeriProcedureRuntimeDecision {
  authorized: true;
  identity: {
    source: 'firm';
    recordId: string;
    canonicalId: string;
    version: number;
  };
  manifestDigest: string;
}

function unavailable(): never {
  throw new NotFoundException('Current procedure execution authority is unavailable');
}

/**
 * Revalidates one prepared procedure/tool invocation against the canonical,
 * uncached firm-skill owner and the authenticated conversation owner. This
 * endpoint can only reject or confirm the exact prepared identity; it returns
 * no instructions, evidence, credentials, or additional tool authority.
 */
@Injectable()
export class MeriProcedureRuntimeValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly firmSkills: MeriFirmSkillsService,
  ) {}

  async validate(
    ctx: TenantContext,
    input: ValidateMeriProcedureRuntimeInput,
  ): Promise<MeriProcedureRuntimeDecision> {
    const conversation = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const owned = await tx.clioConversation.findFirst({
        where: {
          id: input.conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, clientId: true },
      });
      if (!owned || owned.clientId !== input.clientId) return null;
      if (
        owned.clientId &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, owned.clientId))
      ) {
        return null;
      }
      return owned;
    });
    if (!conversation) unavailable();

    let current;
    try {
      current = await resolveCurrentServedProcedure({
        tenantId: ctx.tenantId,
        clientId: conversation.clientId,
        reference: {
          source: 'firm',
          recordId: input.recordId,
          canonicalId: input.canonicalId,
          version: input.procedureVersion,
        },
        firmSkills: this.firmSkills,
      });
    } catch {
      unavailable();
    }

    const binding = current.binding;
    if (
      binding.identity.recordId !== input.recordId ||
      binding.identity.canonicalId !== input.canonicalId ||
      binding.identity.version !== input.procedureVersion ||
      binding.manifestDigest !== input.manifestDigest ||
      binding.scope !== input.scope ||
      binding.clientId !== input.clientId ||
      !binding.policy.allowedTools.includes(input.toolName)
    ) {
      unavailable();
    }

    return {
      authorized: true,
      identity: { ...binding.identity },
      manifestDigest: binding.manifestDigest,
    };
  }
}
