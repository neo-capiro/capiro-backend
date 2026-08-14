import { afterEach, describe, expect, test } from '@jest/globals';
import { MailboxKnowledgeFlagsService, readBooleanFlag } from './mailbox-knowledge-flags.service.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('MailboxKnowledgeFlagsService', () => {
  test('fails closed unless both architecture and mailbox flags are on', () => {
    process.env.KNOWLEDGE_PLANE_ENABLED = 'true';
    delete process.env.MAILBOX_KNOWLEDGE_INGEST_ENABLED;
    expect(new MailboxKnowledgeFlagsService().enabled()).toBe(false);

    process.env.MAILBOX_KNOWLEDGE_INGEST_ENABLED = 'on';
    expect(new MailboxKnowledgeFlagsService().enabled()).toBe(true);
  });

  test('accepts only explicit true values', () => {
    process.env.TEST_FLAG = 'yes';
    expect(readBooleanFlag('TEST_FLAG')).toBe(true);
    process.env.TEST_FLAG = 'sometimes';
    expect(readBooleanFlag('TEST_FLAG')).toBe(false);
  });

  test('bounds worker controls', () => {
    process.env.MAILBOX_KNOWLEDGE_BATCH_SIZE = '10000';
    process.env.MAILBOX_KNOWLEDGE_POLL_INTERVAL_MS = '1';
    process.env.MAILBOX_KNOWLEDGE_MAX_ATTEMPTS = '-4';
    const flags = new MailboxKnowledgeFlagsService();
    expect(flags.batchSize()).toBe(100);
    expect(flags.pollIntervalMs()).toBe(1_000);
    expect(flags.maxAttempts()).toBe(1);
  });
});
