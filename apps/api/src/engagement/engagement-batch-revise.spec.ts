// generateBatchEmails revision ("Improve") threading (W2.6). A single-recipient
// batch carrying `existingBody` must reach the AI draft boundary in revision
// mode: existingSubject/existingBody forwarded and the freeform instruction used
// as the objective. A MULTI-recipient batch must NOT enter revision mode even if
// existingBody is present (guard), so one edited body can't overwrite a fan-out.
//
// Prototype-stub pattern (mirrors engagement-batch-group.spec).

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

interface CapturedInput {
  objective?: string | null;
  existingSubject?: string | null;
  existingBody?: string | null;
}

function serviceCapturingInput(): {
  service: EngagementService;
  inputs: CapturedInput[];
} {
  const inputs: CapturedInput[] = [];
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.ai = {
    resolveOutreachCredentials: async () => [
      {
        provider: 'anthropic',
        apiKey: 'k',
        model: 'm',
        usedTenantKey: false,
        modelOverridden: false,
      },
    ],
    generateOutreachDraft: async (input: CapturedInput) => {
      inputs.push({
        objective: input.objective ?? null,
        existingSubject: input.existingSubject ?? null,
        existingBody: input.existingBody ?? null,
      });
      return { subject: 's', body: 'b', provider: 'anthropic', model: 'm', raw: {} };
    },
  };
  patch.prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        user: {
          findFirst: async () => ({ firstName: 'Uma', lastName: 'Sender', email: 'uma@firm.com' }),
        },
      }),
  };
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
    const { service, inputs } = serviceCapturingInput();
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
    expect(inputs[0]!.objective).toBe('Make it warmer and add a line about the markup.');
  });

  test('multi-recipient batch does NOT enter revision mode even with existingBody', async () => {
    const { service, inputs } = serviceCapturingInput();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_A, RECIPIENT_B],
      existingBody: 'one body',
      reviseInstruction: 'do not apply to a fan-out',
    });
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.existingBody).toBeNull();
      // Objective falls back to the template prompt, not the revise instruction.
      expect(input.objective).not.toBe('do not apply to a fan-out');
    }
  });

  test('single-recipient WITHOUT existingBody is a normal draft (no revision)', async () => {
    const { service, inputs } = serviceCapturingInput();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_A],
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.existingBody).toBeNull();
  });
});
