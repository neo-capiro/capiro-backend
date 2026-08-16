// EngagementMailSender routing: a resolved connection's provider decides which
// adapter sends. This is the single choke point that makes Gmail *and* Outlook
// work at every send site, so the routing must be exact.

import { describe, expect, jest, test } from '@jest/globals';
import { EngagementProvider } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementMailSender, type EngagementSendMailInput } from './mail-sender.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

const runtimePolicy = {
  backgroundWorkersEnabled: () => true,
  assertBackgroundOwner: () => {},
  assertExternalAction: () => {},
  assertCallbacksEnabled: () => {},
  externalActionAllowed: () => true,
  snapshot: () => ({ serviceName: 'api', processMode: 'active', backgroundOwner: 'api', externalActions: 'enabled', callbacksEnabled: true, recallWebhookEnabled: true }),
  isRecallWebhookEnabled: () => true,
} as unknown as EngagementRuntimePolicyService;

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as TenantContext;
const input: EngagementSendMailInput = {
  subject: 's',
  body: 'b',
  toRecipients: [{ email: 'to@x.com' }],
};

function build() {
  const graph = { sendMail: jest.fn(async () => ({ ok: true })) };
  const gmail = { sendMail: jest.fn(async () => ({ ok: true })) };
  const sender = new EngagementMailSender(graph as never, gmail as never, runtimePolicy);
  return { sender, graph, gmail };
}

describe('EngagementMailSender', () => {
  test('routes google_workspace to the Gmail adapter', async () => {
    const { sender, graph, gmail } = build();
    await sender.sendMail(
      ctx,
      { id: 'conn-g', provider: EngagementProvider.google_workspace },
      input,
    );
    // The sender stamps the exact runtime action onto the provider input so the
    // guarded integration boundary can tell an Outreach V3 send apart from a
    // classic one instead of reclassifying it as generic integration sync.
    expect(gmail.sendMail).toHaveBeenCalledWith(ctx, 'conn-g', {
      ...input,
      runtimeAction: 'outreach_send',
    });
    expect(graph.sendMail).not.toHaveBeenCalled();
  });

  test('routes microsoft_365 to the Graph adapter', async () => {
    const { sender, graph, gmail } = build();
    await sender.sendMail(ctx, { id: 'conn-m', provider: EngagementProvider.microsoft_365 }, input);
    expect(graph.sendMail).toHaveBeenCalledWith(ctx, 'conn-m', {
      ...input,
      runtimeAction: 'outreach_send',
    });
    expect(gmail.sendMail).not.toHaveBeenCalled();
  });

  test('propagates the exact V3 send action to the provider adapter', async () => {
    const { sender, gmail } = build();
    await sender.sendMail(
      ctx,
      { id: 'conn-g', provider: EngagementProvider.google_workspace },
      input,
      'outreach_v3_send',
    );
    expect(gmail.sendMail).toHaveBeenCalledWith(ctx, 'conn-g', {
      ...input,
      runtimeAction: 'outreach_v3_send',
    });
  });

  test('a V3 test send is marked test-mode at the last gate before the wire', async () => {
    const assertExternalAction = jest.fn();
    const policy = { ...runtimePolicy, assertExternalAction } as never;
    const graph = { sendMail: jest.fn(async () => ({ ok: true })) };
    const gmail = { sendMail: jest.fn(async () => ({ ok: true })) };
    const sender = new EngagementMailSender(graph as never, gmail as never, policy);

    await sender.sendMail(
      ctx,
      { id: 'conn-g', provider: EngagementProvider.google_workspace },
      input,
      'outreach_v3_test_send',
    );

    expect(assertExternalAction).toHaveBeenCalledWith('outreach_v3_test_send', { testMode: true });
  });
});
