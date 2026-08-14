import { describe, expect, jest, test } from '@jest/globals';
import type { KnowledgeEventRecord } from '../knowledge.types.js';
import { KnowledgeEventRepository } from './knowledge-event.repository.js';
import {
  KnowledgeEventService,
  normalizeKnowledgeEvent,
} from './knowledge-event.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT_HASH = 'a'.repeat(64);

function baseInput() {
  return {
    sourceType: 'gmail_message',
    sourceId: 'message-123',
    sourceVersion: 'v1',
    sourceContentHash: CONTENT_HASH,
    eventType: 'email_received',
    occurredAt: new Date('2026-03-14T14:00:00.000Z'),
    observedAt: new Date('2026-03-14T14:05:00.000Z'),
    evidenceLocator: { provider: 'google', messageId: 'message-123' },
  } as const;
}

describe('KnowledgeEventService', () => {
  test('builds a deterministic source identity independent of metadata and ingestion timing', () => {
    const first = normalizeKnowledgeEvent(TENANT_ID, {
      ...baseInput(),
      metadata: { attempt: 1 },
    });
    const second = normalizeKnowledgeEvent(TENANT_ID, {
      ...baseInput(),
      metadata: { attempt: 2, worker: 'retry' },
    });

    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects an assistant answer as factual source evidence', () => {
    expect(() =>
      normalizeKnowledgeEvent(TENANT_ID, {
        ...baseInput(),
        sourceType: 'meri_answer',
      }),
    ).toThrow('AI-generated answers cannot be persisted');
  });

  test('rejects impossible observation ordering', () => {
    expect(() =>
      normalizeKnowledgeEvent(TENANT_ID, {
        ...baseInput(),
        observedAt: new Date('2026-03-14T13:59:00.000Z'),
      }),
    ).toThrow('observedAt cannot be before occurredAt');
  });

  test('passes a normalized tenant-bound append to the repository', async () => {
    const append = jest.fn(async (tenantId: string, input: ReturnType<typeof normalizeKnowledgeEvent>) =>
      ({
        ...input,
        id: EVENT_ID,
        tenantId,
        ingestedAt: new Date('2026-03-14T14:06:00.000Z'),
        createdAt: new Date('2026-03-14T14:06:00.000Z'),
      }) satisfies KnowledgeEventRecord,
    );
    const repository = { append, findById: jest.fn() } as unknown as KnowledgeEventRepository;
    const service = new KnowledgeEventService(repository);

    const created = await service.append(TENANT_ID, baseInput());

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toBe(TENANT_ID);
    expect(created.id).toBe(EVENT_ID);
    expect(created.accessScope).toEqual({ kind: 'tenant' });
    expect(created.sensitivity).toBe('normal');
  });
});
