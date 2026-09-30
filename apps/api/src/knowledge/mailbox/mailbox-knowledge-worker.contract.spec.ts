import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function repositoryPath(relativePath: string): string {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), 'apps/api', relativePath),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prismaModelHasFieldType(
  source: string,
  modelName: string,
  fieldName: string,
  fieldType: string,
): boolean {
  function maskCommentsAndStrings(): string {
    const masked = source.split('');
    const mask = (index: number): void => {
      if (source[index] !== '\n' && source[index] !== '\r') masked[index] = ' ';
    };
    let index = 0;

    while (index < source.length) {
      if (source.startsWith('//', index)) {
        while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
          mask(index);
          index += 1;
        }
        continue;
      }

      if (source.startsWith('/*', index)) {
        mask(index);
        mask(index + 1);
        index += 2;
        while (index < source.length) {
          if (source.startsWith('*/', index)) {
            mask(index);
            mask(index + 1);
            index += 2;
            break;
          }
          mask(index);
          index += 1;
        }
        continue;
      }

      if (source[index] === '"') {
        const delimiterLength = source.startsWith('"""', index) ? 3 : 1;
        for (let offset = 0; offset < delimiterLength; offset += 1) mask(index + offset);
        index += delimiterLength;

        while (index < source.length) {
          if (source[index] === '\\') {
            mask(index);
            index += 1;
            if (index < source.length) {
              mask(index);
              index += 1;
            }
            continue;
          }

          const isEnd =
            delimiterLength === 3 ? source.startsWith('"""', index) : source[index] === '"';
          if (isEnd) {
            for (let offset = 0; offset < delimiterLength; offset += 1) mask(index + offset);
            index += delimiterLength;
            break;
          }

          mask(index);
          index += 1;
        }
        continue;
      }

      index += 1;
    }

    return masked.join('');
  }

  const lexicalSource = maskCommentsAndStrings();
  const modelStart = new RegExp(
    `^[\\t ]*model[\\t ]+${escapeRegExp(modelName)}[\\t ]*\\{[\\t ]*\\r?$`,
    'm',
  ).exec(lexicalSource);
  if (!modelStart || modelStart.index === undefined) return false;

  const bodyStart = modelStart.index + modelStart[0].length;
  const modelEnd = /^[\t ]*}[\t ]*\r?$/gm;
  modelEnd.lastIndex = bodyStart;
  const endMatch = modelEnd.exec(lexicalSource);
  if (!endMatch) return false;

  const modelBody = lexicalSource.slice(bodyStart, endMatch.index);
  return new RegExp(
    `^[\\t ]*${escapeRegExp(fieldName)}[\\t ]+${escapeRegExp(fieldType)}(?:[\\t ]+.*)?\\r?$`,
    'm',
  ).test(modelBody);
}

const consumer = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge.consumer.ts'),
  'utf8',
);
const flags = readFileSync(
  repositoryPath('src/knowledge/mailbox/mailbox-knowledge-flags.service.ts'),
  'utf8',
);
const drain = readFileSync(repositoryPath('scripts/drain-mailbox-knowledge.ts'), 'utf8');
const dispatcher = readFileSync(repositoryPath('scripts/entrypoint-dispatcher.inc'), 'utf8');
const schema = readFileSync(repositoryPath('prisma/schema.prisma'), 'utf8');
const alignWorkflow = join(
  process.cwd(),
  '../../.github/workflows/knowledge-schema-align-once.yml',
);
const alignScript = join(process.cwd(), '../../scripts/align-mailbox-knowledge-prisma-schema.mjs');
const knowledgeCi = readFileSync(
  join(process.cwd(), '../../.github/workflows/knowledge-plane-ci.yml'),
  'utf8',
);

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
    expect(schema).toMatch(/\bknowledgeJobs\s+KnowledgeMailboxJob\[\]/);
    expect(schema).toMatch(/\bmailboxJobs\s+KnowledgeMailboxJob\[\]/);
    expect(
      prismaModelHasFieldType(schema, 'MailMessage', 'knowledgeJobs', 'KnowledgeMailboxJob[]'),
    ).toBe(true);
    expect(
      prismaModelHasFieldType(schema, 'KnowledgeEvent', 'mailboxJobs', 'KnowledgeMailboxJob[]'),
    ).toBe(true);
    expect(existsSync(alignWorkflow)).toBe(false);
    expect(existsSync(alignScript)).toBe(false);
    expect(knowledgeCi).not.toContain('align-mailbox-knowledge-prisma-schema.mjs');
    expect(knowledgeCi).not.toContain('align-knowledge-plane-prisma-schema.mjs');
  });

  test('scopes relation checks to the owning model without depending on field alignment', () => {
    const whitespaceVariation = `model MailMessage {
\tknowledgeJobs\tKnowledgeMailboxJob[]
}

model KnowledgeEvent {
  mailboxJobs          KnowledgeMailboxJob[]
}`;
    expect(
      prismaModelHasFieldType(
        whitespaceVariation,
        'MailMessage',
        'knowledgeJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(true);
    expect(
      prismaModelHasFieldType(
        whitespaceVariation,
        'KnowledgeEvent',
        'mailboxJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(true);

    const missingRelation = `model MailMessage {
  id String
}`;
    expect(
      prismaModelHasFieldType(
        missingRelation,
        'MailMessage',
        'knowledgeJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(false);

    const wrongType = `model MailMessage {
  knowledgeJobs KnowledgeMailboxExtractionJob[]
}`;
    expect(
      prismaModelHasFieldType(wrongType, 'MailMessage', 'knowledgeJobs', 'KnowledgeMailboxJob[]'),
    ).toBe(false);

    const relationInAnotherModel = `model MailMessage {
  id String
}

model KnowledgeEvent {
  knowledgeJobs KnowledgeMailboxJob[]
}`;
    expect(
      prismaModelHasFieldType(
        relationInAnotherModel,
        'MailMessage',
        'knowledgeJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(false);

    const blockCommentedRelation = `model MailMessage {
  id String
  /*
  knowledgeJobs KnowledgeMailboxJob[]
  */
}`;
    expect(
      prismaModelHasFieldType(
        blockCommentedRelation,
        'MailMessage',
        'knowledgeJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(false);

    const entirelyCommentedModel = `/*
model MailMessage {
  knowledgeJobs KnowledgeMailboxJob[]
}
*/`;
    expect(
      prismaModelHasFieldType(
        entirelyCommentedModel,
        'MailMessage',
        'knowledgeJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(false);

    const relationInMultilineString = `model MailMessage {
  id String
  note String @default("""
  knowledgeJobs KnowledgeMailboxJob[]
  """)
}`;
    expect(
      prismaModelHasFieldType(
        relationInMultilineString,
        'MailMessage',
        'knowledgeJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(false);

    const relationWithAttributeStrings = `model MailMessage {
  note String @default("escaped quote: \\"; // and /* remain string content */")
  knowledgeJobs KnowledgeMailboxJob[] @relation("MailMessage // /* jobs */")
}`;
    expect(
      prismaModelHasFieldType(
        relationWithAttributeStrings,
        'MailMessage',
        'knowledgeJobs',
        'KnowledgeMailboxJob[]',
      ),
    ).toBe(true);
  });
});
