import { describe, expect, test } from '@jest/globals';
import { sha256Text } from '../knowledge.helpers.js';
import type { KnowledgeEventRecord } from '../knowledge.types.js';
import { KnowledgeEvidenceValidatorService } from './knowledge-evidence-validator.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_TEXT = 'Please avoid focusing on autonomy claims in this draft.';
const EXCERPT = 'avoid focusing on autonomy claims';
const START_OFFSET = SOURCE_TEXT.indexOf(EXCERPT);
const END_OFFSET = START_OFFSET + EXCERPT.length;
const CONTENT_HASH = sha256Text(SOURCE_TEXT);

function event(overrides: Partial<KnowledgeEventRecord> = {}): KnowledgeEventRecord {
  return {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    idempotencyKey: 'a'.repeat(64),
    sourceType: 'gmail_message',
    sourceId: 'message-123',
    sourceVersion: 'v1',
    sourceContentHash: CONTENT_HASH,
    eventType: 'email_received',
    occurredAt: new Date('2026-03-14T14:00:00.000Z'),
    observedAt: new Date('2026-03-14T14:05:00.000Z'),
    ingestedAt: new Date('2026-03-14T14:06:00.000Z'),
    actorRefs: [],
    entityRefs: [],
    clientRefs: [],
    sensitivity: 'normal',
    accessScope: { kind: 'tenant' },
    evidenceLocator: { provider: 'google', messageId: 'message-123' },
    metadata: {},
    originTraceId: null,
    status: 'active',
    createdAt: new Date('2026-03-14T14:06:00.000Z'),
    ...overrides,
  };
}

function input() {
  return {
    eventId: EVENT_ID,
    sourceType: 'gmail_message',
    sourceId: 'message-123',
    excerpt: EXCERPT,
    startOffset: START_OFFSET,
    endOffset: END_OFFSET,
    contentHash: CONTENT_HASH,
    sourceText: SOURCE_TEXT,
  };
}

const validator = new KnowledgeEvidenceValidatorService();

describe('KnowledgeEvidenceValidatorService', () => {
  test('accepts an exact excerpt bound to the event content hash', () => {
    expect(validator.normalize(TENANT_ID, event(), input())).toEqual({
      eventId: EVENT_ID,
      sourceType: 'gmail_message',
      sourceId: 'message-123',
      excerpt: EXCERPT,
      startOffset: START_OFFSET,
      endOffset: END_OFFSET,
      contentHash: CONTENT_HASH,
    });
  });

  test('rejects paraphrased or offset-mismatched excerpts', () => {
    expect(() =>
      validator.normalize(TENANT_ID, event(), {
        ...input(),
        excerpt: 'avoid autonomy claims',
      }),
    ).toThrow('must exactly equal sourceText.slice');

    expect(() =>
      validator.normalize(TENANT_ID, event(), {
        ...input(),
        startOffset: -1,
      }),
    ).toThrow('non-negative integer');

    expect(() =>
      validator.normalize(TENANT_ID, event(), {
        ...input(),
        endOffset: SOURCE_TEXT.length + 1,
      }),
    ).toThrow('exceeds the canonical source text');
  });

  test('rejects a different source version or canonical body', () => {
    expect(() =>
      validator.normalize(TENANT_ID, event(), {
        ...input(),
        contentHash: 'f'.repeat(64),
      }),
    ).toThrow('must match the KnowledgeEvent source version');

    expect(() =>
      validator.normalize(TENANT_ID, event(), {
        ...input(),
        sourceText: `${SOURCE_TEXT} changed`,
      }),
    ).toThrow('does not match the event content hash');
  });

  test('rejects mismatched source identity and withdrawn evidence', () => {
    expect(() =>
      validator.normalize(TENANT_ID, event(), {
        ...input(),
        sourceId: 'other-message',
      }),
    ).toThrow('sourceId must match');

    expect(() =>
      validator.normalize(TENANT_ID, event({ status: 'withdrawn' }), input()),
    ).toThrow('active KnowledgeEvent');
  });

  test('rejects model output even if a malformed row reaches the validator', () => {
    expect(() =>
      validator.normalize(
        TENANT_ID,
        event({ sourceType: 'model_output' }),
        { ...input(), sourceType: 'model_output' },
      ),
    ).toThrow('AI-generated answer');
  });

  test('rejects cross-tenant evidence', () => {
    expect(() =>
      validator.normalize(
        TENANT_ID,
        event({ tenantId: '33333333-3333-4333-8333-333333333333' }),
        input(),
      ),
    ).toThrow('same tenant');
  });
});
