import { HttpException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { createGovernedMeriToolsService } from './governed-meri-tools.proxy.js';
import { MeriToolsService, TOOL_DEFINITIONS } from './meri-tools.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;

function rawWith(errorOrResult: unknown, rejects = true): MeriToolsService {
  const execute = rejects
    ? jest.fn(async () => Promise.reject(errorOrResult))
    : jest.fn(async () => errorOrResult);
  const executeFromAuthenticatedUser = rejects
    ? jest.fn(async () => Promise.reject(errorOrResult))
    : jest.fn(async () => errorOrResult);
  return { execute, executeFromAuthenticatedUser } as unknown as MeriToolsService;
}

describe('governed Meri tools adapter', () => {
  test('shared correction review is returned as an honest tool outcome, not a failure', async () => {
    const raw = rawWith(
      new HttpException(
        {
          code: 'memory_pending_review',
          status: 'pending_review',
          message: 'Submitted for independent review.',
          title: 'Firm Positions',
          candidateId: '33333333-3333-4333-8333-333333333333',
          activeItemUnchanged: true,
        },
        202,
      ),
    );
    const tools = createGovernedMeriToolsService(raw);

    await expect(tools.execute(ctx, 'correct_memory', {})).resolves.toEqual({
      corrected: false,
      pendingReview: true,
      status: 'pending_review',
      title: 'Firm Positions',
      candidateId: '33333333-3333-4333-8333-333333333333',
      activeItemUnchanged: true,
      message: 'Submitted for independent review.',
    });
  });

  test('exact duplicate is truthful and does not claim that a new version was created', async () => {
    const raw = rawWith(
      new HttpException(
        {
          code: 'memory_duplicate',
          status: 'duplicate',
          message: 'No correction was applied because the content already controls this scope.',
          title: 'Firm Positions',
          memoryItemId: '44444444-4444-4444-8444-444444444444',
        },
        208,
      ),
    );
    const tools = createGovernedMeriToolsService(raw);

    await expect(tools.executeFromAuthenticatedUser(ctx, 'correct_memory', {})).resolves.toEqual({
      corrected: false,
      duplicate: true,
      status: 'duplicate',
      title: 'Firm Positions',
      memoryItemId: '44444444-4444-4444-8444-444444444444',
      message: 'No correction was applied because the content already controls this scope.',
    });
  });

  test('unrelated results and errors preserve the original MeriToolsService contract', async () => {
    const result = { ok: true };
    const successful = createGovernedMeriToolsService(rawWith(result, false));
    await expect(successful.execute(ctx, 'search_memory', {})).resolves.toBe(result);

    const failure = new Error('real tool failure');
    const failing = createGovernedMeriToolsService(rawWith(failure));
    await expect(failing.execute(ctx, 'search_memory', {})).rejects.toBe(failure);
  });

  test('tool guidance explains the independent-review behavior before execution', () => {
    createGovernedMeriToolsService(rawWith({ ok: true }, false));
    const definition = TOOL_DEFINITIONS.find((item) => item.name === 'correct_memory');
    expect(definition?.description).toContain('Firm/client memory is submitted for independent review');
  });
});
