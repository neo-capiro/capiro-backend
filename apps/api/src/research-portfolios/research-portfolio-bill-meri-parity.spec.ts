import { executeResearchPortfolioManagement } from './research-portfolio-management.js';

/**
 * Meri parity for bills (requirement 14g, adapter level).
 *
 * The Meri management action must reach the same service the browser uses, with the bill's
 * canonical kind intact and no Meri-only allow-list in the way. This is not a live Meri turn;
 * it proves the adapter path, which is the part code can prove.
 */
const ctx: any = { tenantId: 'tenant-bills', userId: 'actor-bills', role: 'standard_user' };
const portfolioId = 'portfolio-bills';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';

function services() {
  const createMember = jest.fn(async () => ({ memberId: 'member-1', revision: 4 }));
  return {
    createMember,
    services: {
      portfolios: { createMember },
      analytics: {},
      changes: {},
      outputs: {},
      reviews: {},
      rules: {},
      phase11: {},
    } as any,
  };
}

describe('Meri bill membership goes through the shared portfolio service', () => {
  it('forwards a federal bill with its canonical kind and identity unchanged', async () => {
    const { createMember, services: s } = services();
    await executeResearchPortfolioManagement(s, ctx, portfolioId, {
      conversationId: CONVERSATION,
      action: 'member_create',
      // A mutation requires the signed-in user's own confirmation; no second approver.
      confirmed: true,
      parameters: {
        idempotencyKey: 'bill-add-1',
        expectedRevision: 3,
        targetKind: 'federal_bill',
        targetId: '119-hr-8800',
        label: 'H.R. 8800 — Defense Appropriations',
      },
    });

    expect(createMember).toHaveBeenCalledWith(ctx, portfolioId, {
      idempotencyKey: 'bill-add-1',
      expectedRevision: 3,
      targetKind: 'federal_bill',
      targetId: '119-hr-8800',
      label: 'H.R. 8800 — Defense Appropriations',
    });
  });

  it('forwards a session-qualified state bill without rewriting its identity', async () => {
    const { createMember, services: s } = services();
    await executeResearchPortfolioManagement(s, ctx, portfolioId, {
      conversationId: CONVERSATION,
      action: 'member_create',
      // A mutation requires the signed-in user's own confirmation; no second approver.
      confirmed: true,
      parameters: {
        idempotencyKey: 'bill-add-2',
        expectedRevision: 3,
        targetKind: 'state_bill',
        targetId: 'CA-20252026-HB123',
      },
    });

    expect((createMember.mock.calls[0] as any[])[2]).toMatchObject({
      targetKind: 'state_bill',
      targetId: 'CA-20252026-HB123',
    });
  });

  it('refuses a bill membership change the user has not confirmed', async () => {
    const { createMember, services: s } = services();
    await expect(
      executeResearchPortfolioManagement(s, ctx, portfolioId, {
        conversationId: CONVERSATION,
        action: 'member_create',
        parameters: {
          idempotencyKey: 'unconfirmed',
          expectedRevision: 3,
          targetKind: 'federal_bill',
          targetId: '119-hr-8800',
        },
      }),
    ).rejects.toThrow();
    expect(createMember).not.toHaveBeenCalled();
  });

  it('still rejects a kind the portfolio does not support', async () => {
    const { createMember, services: s } = services();
    await expect(
      executeResearchPortfolioManagement(s, ctx, portfolioId, {
        conversationId: CONVERSATION,
        action: 'member_create',
        confirmed: true,
        parameters: {
          idempotencyKey: 'bad',
          expectedRevision: 3,
          targetKind: 'legislator',
          targetId: 'x',
        },
      }),
    ).rejects.toThrow();
    expect(createMember).not.toHaveBeenCalled();
  });
});
