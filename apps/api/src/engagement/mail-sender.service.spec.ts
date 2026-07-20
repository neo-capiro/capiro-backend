// EngagementMailSender routing: a resolved connection's provider decides which
// adapter sends. This is the single choke point that makes Gmail *and* Outlook
// work at every send site, so the routing must be exact.

import { describe, expect, jest, test } from '@jest/globals';
import { EngagementProvider } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementMailSender, type EngagementSendMailInput } from './mail-sender.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as TenantContext;
const input: EngagementSendMailInput = {
  subject: 's',
  body: 'b',
  toRecipients: [{ email: 'to@x.com' }],
};

function build() {
  const graph = { sendMail: jest.fn(async () => ({ ok: true })) };
  const gmail = { sendMail: jest.fn(async () => ({ ok: true })) };
  const sender = new EngagementMailSender(graph as never, gmail as never);
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
    expect(gmail.sendMail).toHaveBeenCalledWith(ctx, 'conn-g', input);
    expect(graph.sendMail).not.toHaveBeenCalled();
  });

  test('routes microsoft_365 to the Graph adapter', async () => {
    const { sender, graph, gmail } = build();
    await sender.sendMail(ctx, { id: 'conn-m', provider: EngagementProvider.microsoft_365 }, input);
    expect(graph.sendMail).toHaveBeenCalledWith(ctx, 'conn-m', input);
    expect(gmail.sendMail).not.toHaveBeenCalled();
  });
});
