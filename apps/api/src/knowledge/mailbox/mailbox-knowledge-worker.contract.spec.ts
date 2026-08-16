import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function repositoryPath(relativePath: string): string {
  const candidates = [join(process.cwd(), relativePath), join(process.cwd(), 'apps/api', relativePath)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

const consumer = readFileSync(repositoryPath('src/knowledge/mailbox/mailbox-knowledge.consumer.ts'), 'utf8');
const flags = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge-flags.service.ts'),
  'utf8',
);
const drain = readFileSync(repositoryPath('scripts/drain-mailbox-knowledge.ts'), 'utf8');
const dispatcher = readFileSync(repositoryPath('scripts/entrypoint-dispatcher.inc'), 'utf8');
const schema = readFileSync(repositoryPath('prisma/schema.prisma'), 'utf8');
const alignWorkflow = join(process.cwd(), '../../.github/workflows/knowledge-schema-align-once.yml');
const alignScript = join(process.cwd(), '../../scripts/align-mailbox-knowledge-prisma-schema.mjs');
const knowledgeCi = readFileSync(join(process.cwd(), '../../.github/workflows/knowledge-plane-ci.yml'), 'utf8');

describe('Phase 4 mailbox knowledge worker architecture', () => {
  test('does not start an in-process timer from the HTTP API process', () => {
    expect(consumer).not.toMatch(/OnModuleInit|setInterval|pollIntervalMs/);
    expect(flags).not.toContain('pollIntervalMs');
    expect(consumer).toContain('drainOnce');
    expect(consumer).toContain('this.repository.loadMessage');
    expect(consumer).not.toMatch(/anthropic|openai|bedrock|nvidia/i);
  });

  test('drains IDs through the established out-of-band worker verb', () => {
    expect(drain).toContain('MailboxKnowledgeConsumer');
    expect(drain).toContain('drainOnce');
    expect(drain).toContain("set_config('app.bypass_rls'");
    expect(drain).toContain('withSystem:');
    expect(drain).toContain('withTenant:');
    expect(drain).not.toMatch(/bodyText|authoritativeText|raw email|message body/i);
    expect(dispatcher).toContain('drain-mailbox-knowledge)');
    expect(dispatcher).toContain('scripts/drain-mailbox-knowledge.ts');
  });

  test('materializes KnowledgeMailboxJob in the checked-in Prisma schema', () => {
    expect(schema).toContain('model KnowledgeMailboxJob {');
    expect(schema).toContain('model KnowledgeEvent {');
    expect(schema).toContain('model KnowledgeAssertion {');
    expect(schema).toContain('model KnowledgeEvidence {');
    expect(schema).toContain('knowledgeMailboxJobs');
    expect(schema).toContain('knowledgeJobs KnowledgeMailboxJob[]');
    expect(schema).toContain('mailboxJobs KnowledgeMailboxJob[]');
    expect(existsSync(alignWorkflow)).toBe(false);
    expect(existsSync(alignScript)).toBe(false);
    expect(knowledgeCi).not.toContain('align-mailbox-knowledge-prisma-schema.mjs');
    expect(knowledgeCi).not.toContain('align-knowledge-plane-prisma-schema.mjs');
  });
});
