import { afterEach, describe, expect, test } from '@jest/globals';
import {
  MailboxKnowledgeFlagsService,
  readBooleanFlag,
} from './mailbox-knowledge-flags.service.js';

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

  test('accepts the documented mailbox gate while preserving the legacy ingest name', () => {
    process.env.KNOWLEDGE_PLANE_ENABLED = 'true';
    process.env.MAILBOX_KNOWLEDGE_ENABLED = 'true';
    delete process.env.MAILBOX_KNOWLEDGE_INGEST_ENABLED;
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
    process.env.MAILBOX_KNOWLEDGE_MAX_ATTEMPTS = '-4';
    const flags = new MailboxKnowledgeFlagsService();
    expect(flags.batchSize()).toBe(100);
    expect(flags.maxAttempts()).toBe(1);
  });

  test('keeps Phase 6 extraction off by default and bounds its controls', () => {
    process.env.KNOWLEDGE_PLANE_ENABLED = 'true';
    process.env.MAILBOX_KNOWLEDGE_INGEST_ENABLED = 'on';
    delete process.env.MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED;
    expect(new MailboxKnowledgeFlagsService().extractionEnabled()).toBe(false);

    process.env.MAILBOX_KNOWLEDGE_EXTRACTION_ENABLED = 'true';
    process.env.MAILBOX_KNOWLEDGE_EXTRACTION_BATCH_SIZE = '10000';
    process.env.MAILBOX_KNOWLEDGE_EXTRACTION_MAX_ATTEMPTS = '-4';
    const flags = new MailboxKnowledgeFlagsService();
    expect(flags.extractionEnabled()).toBe(true);
    expect(flags.extractionBatchSize()).toBe(50);
    expect(flags.extractionMaxAttempts()).toBe(1);
  });
});
