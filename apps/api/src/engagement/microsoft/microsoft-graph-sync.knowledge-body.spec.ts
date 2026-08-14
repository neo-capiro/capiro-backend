import { describe, expect, test } from '@jest/globals';
import { MICROSOFT_SCOPES } from './microsoft-oauth-constants.js';
import {
  MicrosoftGraphSyncService,
  resolveGraphAuthoritativeBody,
} from './microsoft-graph-sync.service.js';

function setup() {
  const upsert = jest.fn().mockResolvedValue({ id: 'mail-1' });
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    mailMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert,
    },
    mailThread: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'thread-1' }),
      update: jest.fn().mockResolvedValue({ id: 'thread-1' }),
    },
    engagementContact: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    clientAssociationOverride: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    withTenant: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
    withTenantRetry: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
  };
  const association = {
    associate: jest.fn(async () => ({
      clientId: 'client-1',
      score: 0.9,
      reason: 'match',
      signals: {},
    })),
  };
  const service = new MicrosoftGraphSyncService(
    prisma as never,
    {} as never,
    association as never,
    { get: () => undefined } as never,
  );
  return { service, association, upsert, tx };
}

const FULL_BODY =
  'Please protect PE 0605053A and avoid leading with autonomy in our committee outreach. This is the complete authoritative Microsoft Graph body, not the short preview.';

describe('resolveGraphAuthoritativeBody', () => {
  test('treats a non-empty Graph body as the complete authoritative source', () => {
    const resolved = resolveGraphAuthoritativeBody({
      bodyPreview: 'Please protect PE 0605053A…',
      body: { contentType: 'text', content: FULL_BODY },
    });
    expect(resolved.bodyCompleteness).toBe('full');
    expect(resolved.bodyText).toBe(FULL_BODY);
    expect(resolved.bodyContentType).toBe('text');
  });

  test('strips HTML but still marks a Graph HTML body as full', () => {
    const resolved = resolveGraphAuthoritativeBody({
      bodyPreview: 'Please protect PE 0605053A…',
      body: {
        contentType: 'html',
        content: '<p>Please protect PE 0605053A and avoid leading with autonomy.</p>',
      },
    });
    expect(resolved.bodyCompleteness).toBe('full');
    expect(resolved.bodyText).toContain('Please protect PE 0605053A');
    expect(resolved.bodyText).not.toContain('<p>');
    expect(resolved.bodyContentType).toBe('html');
  });

  test('never treats bodyPreview as evidence of a complete body', () => {
    const resolved = resolveGraphAuthoritativeBody({
      bodyPreview: FULL_BODY,
    });
    expect(resolved.bodyCompleteness).toBe('preview');
    expect(resolved.bodyText).toBe(FULL_BODY);
  });
});

describe('MicrosoftGraphSyncService persistGraphMessage — Knowledge Plane body', () => {
  test('persists the authoritative Graph body and an explicit full completeness marker', async () => {
    const { service, association, upsert } = setup();
    const outcome = await (
      service as unknown as {
        persistGraphMessage: (
          tenantId: string,
          connectionId: string,
          folder: string,
          message: unknown,
        ) => Promise<string>;
      }
    ).persistGraphMessage('tenant-1', 'conn-1', 'inbox', {
      id: 'msg-1',
      conversationId: 'conv-1',
      subject: 'FY28 Ground Robotics strategy',
      bodyPreview: 'Please protect PE 0605053A…',
      body: { contentType: 'text', content: FULL_BODY },
      from: { emailAddress: { address: 'a@acme.com', name: 'A' } },
      toRecipients: [{ emailAddress: { address: 'me@firm.com', name: 'Me' } }],
      receivedDateTime: '2026-08-14T13:00:00Z',
    });

    expect(outcome).toBe('matched');
    expect(association.associate).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      expect.objectContaining({ body: 'Please protect PE 0605053A…' }),
    );
    const upserted = upsert.mock.calls[0]?.[0] as {
      create: { bodyText: string | null; metadata: Record<string, unknown>; raw: Record<string, unknown> };
      update: { bodyText: string | null; metadata: Record<string, unknown>; raw: Record<string, unknown> };
    };
    expect(upserted.create.bodyText).toBe(FULL_BODY);
    expect(upserted.update.bodyText).toBe(FULL_BODY);
    expect(upserted.create.metadata).toEqual(
      expect.objectContaining({ bodyCompleteness: 'full', bodyContentType: 'text' }),
    );
    expect(upserted.update.metadata).toEqual(
      expect.objectContaining({ bodyCompleteness: 'full', bodyContentType: 'text' }),
    );
    expect(upserted.create.raw.body).toEqual({ contentType: 'text' });
  });

  test('keeps mailbox UI on the preview when Graph did not return a full body', async () => {
    const { service, upsert } = setup();
    await (
      service as unknown as {
        persistGraphMessage: (
          tenantId: string,
          connectionId: string,
          folder: string,
          message: unknown,
        ) => Promise<string>;
      }
    ).persistGraphMessage('tenant-1', 'conn-1', 'inbox', {
      id: 'msg-preview',
      conversationId: 'conv-1',
      subject: 'Preview only',
      bodyPreview: 'This is only the short Microsoft Graph body preview.',
      from: { emailAddress: { address: 'a@acme.com', name: 'A' } },
      toRecipients: [{ emailAddress: { address: 'me@firm.com', name: 'Me' } }],
      receivedDateTime: '2026-08-14T13:00:00Z',
    });

    const upserted = upsert.mock.calls[0]?.[0] as {
      create: { bodyText: string | null; metadata: Record<string, unknown> };
    };
    expect(upserted.create.bodyText).toBe('This is only the short Microsoft Graph body preview.');
    expect(upserted.create.metadata).toEqual(expect.objectContaining({ bodyCompleteness: 'preview' }));
  });

  test('does not change the requested Microsoft OAuth scopes to fetch mail bodies', () => {
    expect(MICROSOFT_SCOPES).toEqual(
      expect.arrayContaining(['User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read']),
    );
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'microsoft-graph-sync.service.ts'),
      'utf8',
    );
    expect(source).toContain("/me/messages/${");
    expect(source).toContain('$select=id,body');
    expect(source).toContain("'bodyPreview'");
    expect(source).not.toMatch(/\$select=[^`']*\bbody\b[^`']*delta/);
  });
});
