import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import type {
  MeriServerReadonlyCapturePolicy,
  MeriServerReadonlyCaptureReceipt,
  SignedMeriCaptureEvidenceReceipt,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { planTurnRerun } from './meri-turn.helpers.js';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { captureBudgetRequired } from './meri-capture-provider-budget.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { withCaptureApiProviderScope } from './meri-capture-api-provider-scope.js';
import {
  assertMeriServerReadonlyCaptureCurrentAuthority,
  assertMeriServerReadonlyCaptureTurnInput,
  issueMeriServerReadonlyCapturePolicy,
  meriServerReadonlyCaptureReceipt,
} from './meri-server-readonly-capture.js';

export interface MeriGovernedRuntimeState {
  context: MeriGovernedTurnContext;
  activeClient: { id: string; name: string } | null;
  capturePolicy?: MeriServerReadonlyCapturePolicy | null;
  captureEvidenceReceipt?: SignedMeriCaptureEvidenceReceipt | null;
}

const runtime = new AsyncLocalStorage<MeriGovernedRuntimeState>();

export function currentMeriGovernedRuntime(): MeriGovernedRuntimeState | null {
  return runtime.getStore() ?? null;
}

export function currentMeriServerReadonlyCapturePolicy(): MeriServerReadonlyCapturePolicy | null {
  return currentMeriGovernedRuntime()?.capturePolicy ?? null;
}

export function currentMeriServerReadonlyCaptureReceipt(): MeriServerReadonlyCaptureReceipt | null {
  return meriServerReadonlyCaptureReceipt(currentMeriServerReadonlyCapturePolicy());
}

export function bindCurrentMeriCaptureTurn(turnId: string): MeriServerReadonlyCapturePolicy | null {
  const state = runtime.getStore();
  if (!state?.capturePolicy) return null;
  if (!turnId.trim()) throw new Error('meri_capture_turn_id_missing');
  const policy = Object.freeze({ ...state.capturePolicy, turnId: turnId.trim() });
  state.capturePolicy = policy;
  state.context = { ...state.context, serverReadonlyCapturePolicy: policy };
  return policy;
}

export function setCurrentMeriCaptureEvidenceReceipt(
  receipt: SignedMeriCaptureEvidenceReceipt,
): void {
  const state = runtime.getStore();
  if (!state?.capturePolicy) throw new Error('meri_capture_runtime_missing');
  state.captureEvidenceReceipt = receipt;
}

export function currentMeriCaptureEvidenceReceipt(): SignedMeriCaptureEvidenceReceipt | null {
  return runtime.getStore()?.captureEvidenceReceipt ?? null;
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
    if (prepared.capturePolicy && captureBudgetRequired(prepared.capturePolicy)) {
      assertMeriServerReadonlyCaptureTurnInput({
        policy: prepared.capturePolicy,
        mode: input.mode,
        attachmentIds: [],
      });
      await captureProviderBudgetOwner({
        prisma: this.prisma,
        ctx,
        policy: prepared.capturePolicy,
        operation: { kind: 'admit' },
      });
    }
    return withCaptureApiProviderScope(this.prisma, ctx, prepared.capturePolicy, async () => {
      const resolved = await this.contextPlane.resolveChat(ctx, {
        conversationId: input.conversationId,
        task: prepared.task,
      });
      // Retrieval owns its database work. Stop must prevent the next stage from
      // starting, even when that work finishes after the browser disconnected.
      input.signal?.throwIfAborted();
      assertMeriServerReadonlyCaptureTurnInput({
        policy: prepared.capturePolicy,
        mode: input.mode,
        attachmentIds: [],
      });
      const currentAuthority = await assertMeriServerReadonlyCaptureCurrentAuthority({
        prisma: this.prisma,
        ctx,
        policy: prepared.capturePolicy,
      });
      input.signal?.throwIfAborted();
      const activeClient =
        resolved.retrieval.plan.subjectScope === 'client'
          ? (currentAuthority?.client ?? prepared.client)
          : null;
      const context = prepared.capturePolicy
        ? { ...resolved, serverReadonlyCapturePolicy: prepared.capturePolicy }
        : resolved;
      return runtime.run({ context, activeClient, capturePolicy: prepared.capturePolicy }, fn);
    });
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
    capturePolicy: MeriServerReadonlyCapturePolicy | null;
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
    const capturePolicy = await issueMeriServerReadonlyCapturePolicy({
      prisma: this.prisma,
      ctx,
      conversationId: input.conversationId,
    });

    const cleanBody = cleanStreamControl(input.body);
    if (input.mode === 'new') {
      return {
        task: cleanBody.trim() || '(See the attached file(s).)',
        client: conversation.client ?? null,
        capturePolicy,
      };
    }
    if (input.mode === 'resend') {
      return {
        task: cleanBody.trim(),
        client: conversation.client ?? null,
        capturePolicy,
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
      capturePolicy,
    };
  }
}

function cleanStreamControl(value: string): string {
  let out = value ?? '';
  out = out.replace(/\s*#trace\s*$/i, '').trimEnd();
  out = out.replace(/^\s*write on this page:\s*/i, '').trimStart();
  return out;
}
