import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { planTurnRerun } from './meri-turn.helpers.js';
import { MeriContextPlaneService } from './meri-context-plane.service.js';

export interface MeriGovernedRuntimeState {
  context: MeriGovernedTurnContext;
  activeClient: { id: string; name: string } | null;
}

const runtime = new AsyncLocalStorage<MeriGovernedRuntimeState>();

export function currentMeriGovernedRuntime(): MeriGovernedRuntimeState | null {
  return runtime.getStore() ?? null;
}

@Injectable()
export class MeriContextPlaneRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contextPlane: MeriContextPlaneService,
  ) {}

  async runChatTurn<T>(
    ctx: TenantContext,
    input: {
      conversationId: string;
      body: string;
      mode: 'new' | 'regenerate' | 'resend';
      signal?: AbortSignal;
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    input.signal?.throwIfAborted();
    const prepared = await this.prepareTurn(ctx, input);
    input.signal?.throwIfAborted();
    const context = await this.contextPlane.resolveChat(ctx, {
      conversationId: input.conversationId,
      task: prepared.task,
    });
    // Retrieval owns its database work. Stop must prevent the next stage from
    // starting, even when that work finishes after the browser disconnected.
    input.signal?.throwIfAborted();
    const activeClient = context.retrieval.plan.subjectScope === 'client' ? prepared.client : null;
    return runtime.run({ context, activeClient }, fn);
  }

  private async prepareTurn(
    ctx: TenantContext,
    input: {
      conversationId: string;
      body: string;
      mode: 'new' | 'regenerate' | 'resend';
    },
  ): Promise<{
    task: string;
    client: { id: string; name: string } | null;
  }> {
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: input.conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        include: { client: { select: { id: true, name: true } } },
      }),
    );
    if (!conversation) throw new Error('meri_context_plane_conversation_not_found');

    const cleanBody = cleanStreamControl(input.body);
    if (input.mode === 'new') {
      return {
        task: cleanBody.trim() || '(See the attached file(s).)',
        client: conversation.client ?? null,
      };
    }
    if (input.mode === 'resend') {
      return {
        task: cleanBody.trim(),
        client: conversation.client ?? null,
      };
    }

    const prior = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          conversationId: input.conversationId,
          role: { in: ['user', 'assistant'] },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, body: true },
      }),
    );
    const plan = planTurnRerun(prior, 'regenerate');
    return {
      task: plan?.contentToUse?.trim() || cleanBody.trim() || '(Regenerate previous turn.)',
      client: conversation.client ?? null,
    };
  }
}

function cleanStreamControl(value: string): string {
  let out = value ?? '';
  out = out.replace(/\s*#trace\s*$/i, '').trimEnd();
  out = out.replace(/^\s*write on this page:\s*/i, '').trimStart();
  return out;
}
