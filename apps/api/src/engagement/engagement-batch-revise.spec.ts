// generateBatchEmails revision ("Improve") threading (W2.6). A single-recipient
// batch carrying `existingBody` must reach the gateway generation boundary in
// revision mode: existingSubject/existingBody forwarded and the freeform
// instruction used as the objective. A MULTI-recipient batch must NOT enter
// revision mode even if existingBody is present (guard), so one edited body
// can't overwrite a fan-out.
//
// Prototype-stub pattern (mirrors engagement-batch-group.spec). The Phase 26
// cutover routes batch generation through the governed gateway, so the spy
// sits on gateway.generate's GenerationRequest.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

interface CapturedRequest {
  existingSubject?: string | null;
  existingBody?: string | null;
  reviseInstruction?: string | null;
  objective?: string | null;
}

function serviceCapturingRequest(): {
  service: EngagementService;
  inputs: CapturedRequest[];
} {
  const inputs: CapturedRequest[] = [];
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 26 cutover: batch generation runs through the governed gateway
  // unconditionally; stub its two entry points the batch path uses.
  patch.gateway = {
    resolvePinnedIdentity: async () => ({
      creds: [{ provider: 'anthropic', apiKey: 'test-key', model: 'm' }],
      pinned: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        planModel: 'claude-haiku-4-5-20251001',
        promptSpecVersion: 'v2.2-gateway',
      },
    }),
    generate: async (
      _ctx: unknown,
      request: Record<string, unknown>,
      _enrichment: unknown,
    ) => {
      inputs.push({
        existingSubject: (request.existingSubject as string | null) ?? null,
        existingBody: (request.existingBody as string | null) ?? null,
        reviseInstruction: (request.reviseInstruction as string | null) ?? null,
        objective: (request.objective as string | null) ?? null,
      });
      return {
        outcome: 'ready',
        generationKey: 'individual:a',
        recipientKey: 'a',
        subject: 's',
        body: 'b',
        manifest: {},
        sendable: true,
        pinned: { provider: 'anthropic', model: 'm', planModel: null, promptSpecVersion: 'v2.2-gateway' },
      };
    },
  };
  patch.prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        user: {
          findFirst: async () => ({ firstName: 'Uma', lastName: 'Sender', email: 'uma@firm.com' }),
        },
        aiUsageEvent: {
          aggregate: async () => ({ _sum: { inputTokens: 0, outputTokens: 0 } }),
        },
      }),
  };
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.directory = { findContactsByEmails: async () => [] };
  patch.loadUserVoiceBlock = async () => null;
  patch.batchRecipientCorrespondence = async () => ({
    meetingsByEmail: new Map(),
    threadsByEmail: new Map(),
  });
  patch.outreachMemberPress = async () => new Map();
  patch.recordAiUsage = async () => {};
  return { service, inputs };
}

const RECIPIENT_A = { email: 'a@mail.house.gov', directoryContactId: 'dc-a', name: 'Rep A' };
const RECIPIENT_B = { email: 'b@mail.house.gov', directoryContactId: 'dc-b', name: 'Rep B' };

describe('generateBatchEmails — revision ("Improve") threading (W2.6)', () => {
  test('single-recipient + existingBody enters revision mode', async () => {
    const { service, inputs } = serviceCapturingRequest();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_A],
      existingSubject: 'Re: FY27',
      existingBody: 'Hi — following up on directed-energy funding.',
      reviseInstruction: 'Make it warmer and add a line about the markup.',
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.existingBody).toBe('Hi — following up on directed-energy funding.');
    expect(inputs[0]!.existingSubject).toBe('Re: FY27');
    // The freeform instruction drives the revision objective.
    expect(inputs[0]!.reviseInstruction).toBe('Make it warmer and add a line about the markup.');
  });

  test('multi-recipient batch does NOT enter revision mode even with existingBody', async () => {
    const { service, inputs } = serviceCapturingRequest();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_A, RECIPIENT_B],
      existingSubject: 'Re: do not fan out one edited subject',
      existingBody: 'one body',
      reviseInstruction: 'do not apply to a fan-out',
    });
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.existingSubject).toBeNull();
      expect(input.existingBody).toBeNull();
      expect(input.reviseInstruction).toBeNull();
      // Objective falls back to the template prompt, not the revise instruction.
      expect(input.objective).not.toBe('do not apply to a fan-out');
    }
  });

  test('single-recipient WITHOUT existingBody is a normal draft (no revision)', async () => {
    const { service, inputs } = serviceCapturingRequest();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_A],
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.existingBody).toBeNull();
    // No revision inputs leak into a fresh draft.
    expect(inputs[0]!.existingSubject).toBeNull();
    expect(inputs[0]!.reviseInstruction).toBeNull();
  });
});
