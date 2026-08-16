import { describe, expect, test } from '@jest/globals';
import {
  canonicalClientRefKeys,
  mailboxThreadEpisodeIdentityKey,
  mailboxThreadGroupingKeyFromEvent,
  requireUnambiguousEventScope,
} from './knowledge-episode-identity.js';
import type { KnowledgeEventRecord } from '../knowledge.types.js';

function event(overrides: Partial<KnowledgeEventRecord> = {}): KnowledgeEventRecord {
  return {
    id: 'event-1',
    tenantId: 'tenant-a',
    idempotencyKey: 'key-1',
    sourceType: 'gmail_message',
    sourceId: 'msg-1',
    sourceVersion: 'rev-1',
    sourceContentHash: 'a'.repeat(64),
    eventType: 'email_received',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    observedAt: new Date('2026-01-01T00:00:00Z'),
    ingestedAt: new Date('2026-01-01T00:00:00Z'),
    actorRefs: [],
    entityRefs: [],
    clientRefs: [],
    sensitivity: 'normal',
    accessScope: { kind: 'user', userId: 'user-1', clientIds: [] },
    evidenceLocator: {
      provider: 'google',
      connectionId: 'conn-1',
      providerThreadId: 'thread-abc',
    },
    metadata: {},
    originTraceId: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('mailboxThreadGroupingKeyFromEvent', () => {
  test('returns null when evidenceLocator lacks connectionId or providerThreadId', () => {
    expect(mailboxThreadGroupingKeyFromEvent(event({ evidenceLocator: {} }))).toBeNull();
    expect(
      mailboxThreadGroupingKeyFromEvent(
        event({ evidenceLocator: { connectionId: 'conn-1' } }),
      ),
    ).toBeNull();
    expect(
      mailboxThreadGroupingKeyFromEvent(
        event({ evidenceLocator: { providerThreadId: 'thread-abc' } }),
      ),
    ).toBeNull();
  });

  test('extracts the grouping key from a well-formed event', () => {
    const key = mailboxThreadGroupingKeyFromEvent(event());
    expect(key).toEqual({
      strategy: 'mailbox_thread_v1',
      tenantId: 'tenant-a',
      connectionId: 'conn-1',
      providerThreadId: 'thread-abc',
      sensitivity: 'normal',
      accessScopeDigest: expect.any(String),
      clientRefKeys: [],
    });
  });

  test('never persists the raw account email or source text in the grouping key', () => {
    const key = mailboxThreadGroupingKeyFromEvent(
      event({
        evidenceLocator: {
          connectionId: 'conn-1',
          providerThreadId: 'thread-abc',
          accountEmail: 'private@example.com',
        },
        metadata: { subject: 'Secret matter' },
      }),
    )!;
    expect(JSON.stringify(key)).not.toContain('private@example.com');
    expect(JSON.stringify(key)).not.toContain('Secret matter');
  });
});

describe('canonicalClientRefKeys', () => {
  test('de-duplicates and sorts, independent of input order', () => {
    const a = canonicalClientRefKeys([
      { type: 'client', id: '2' },
      { type: 'client', id: '1' },
      { type: 'client', id: '2' },
    ]);
    const b = canonicalClientRefKeys([
      { type: 'client', id: '1' },
      { type: 'client', id: '2' },
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual(['client:1', 'client:2']);
  });

  test('excludes label/metadata from the key', () => {
    const withLabel = canonicalClientRefKeys([
      { type: 'client', id: '1', label: 'Acme Corp', metadata: { note: 'x' } },
    ]);
    const withoutLabel = canonicalClientRefKeys([{ type: 'client', id: '1' }]);
    expect(withLabel).toEqual(withoutLabel);
  });
});

describe('mailboxThreadEpisodeIdentityKey', () => {
  test('is a 64-character lowercase hex SHA-256 digest', () => {
    const key = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(event())!);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test('duplicates and order differences in client refs never change identity', () => {
    const ordered = event({
      clientRefs: [
        { type: 'client', id: '1' },
        { type: 'client', id: '2' },
      ],
    });
    const reorderedWithDuplicate = event({
      clientRefs: [
        { type: 'client', id: '2' },
        { type: 'client', id: '2' },
        { type: 'client', id: '1' },
      ],
    });
    const keyA = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(ordered)!);
    const keyB = mailboxThreadEpisodeIdentityKey(
      mailboxThreadGroupingKeyFromEvent(reorderedWithDuplicate)!,
    );
    expect(keyA).toBe(keyB);
  });

  test('two mailboxes with the same opaque provider thread id never collide', () => {
    const mailboxA = event({ evidenceLocator: { connectionId: 'conn-a', providerThreadId: 'thread-x' } });
    const mailboxB = event({ evidenceLocator: { connectionId: 'conn-b', providerThreadId: 'thread-x' } });
    const keyA = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(mailboxA)!);
    const keyB = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(mailboxB)!);
    expect(keyA).not.toBe(keyB);
  });

  test('a sensitivity change produces a different identity key (never a widened merge)', () => {
    const normal = event({ sensitivity: 'normal' });
    const confidential = event({ sensitivity: 'confidential' });
    const keyA = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(normal)!);
    const keyB = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(confidential)!);
    expect(keyA).not.toBe(keyB);
  });

  test('an access scope change produces a different identity key', () => {
    const scopeA = event({ accessScope: { kind: 'user', userId: 'user-1', clientIds: [] } });
    const scopeB = event({ accessScope: { kind: 'user', userId: 'user-2', clientIds: [] } });
    const keyA = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(scopeA)!);
    const keyB = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(scopeB)!);
    expect(keyA).not.toBe(keyB);
  });

  test('a different client-ref set produces a different identity key', () => {
    const noClients = event({ clientRefs: [] });
    const oneClient = event({ clientRefs: [{ type: 'client', id: '1' }] });
    const keyA = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(noClients)!);
    const keyB = mailboxThreadEpisodeIdentityKey(mailboxThreadGroupingKeyFromEvent(oneClient)!);
    expect(keyA).not.toBe(keyB);
  });
});

describe('requireUnambiguousEventScope', () => {
  test('throws when sensitivity is missing/empty', () => {
    expect(() => requireUnambiguousEventScope(event({ sensitivity: '' }))).toThrow();
  });

  test('throws when accessScope is not a plain object', () => {
    expect(() =>
      requireUnambiguousEventScope(
        event({ accessScope: null as unknown as Record<string, never> }),
      ),
    ).toThrow();
    expect(() =>
      requireUnambiguousEventScope(
        event({ accessScope: [] as unknown as Record<string, never> }),
      ),
    ).toThrow();
  });

  test('does not throw for a well-formed event', () => {
    expect(() => requireUnambiguousEventScope(event())).not.toThrow();
  });
});
