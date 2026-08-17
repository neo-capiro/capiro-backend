import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function repositoryPath(relativePath: string): string {
  const candidates = [join(process.cwd(), relativePath), join(process.cwd(), 'apps/api', relativePath)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

const source = readFileSync(
  repositoryPath('src/knowledge/graph/temporal-knowledge-graph.repository.ts'),
  'utf8',
);

describe('TemporalKnowledgeGraphRepository contract', () => {
  test('every query re-enters tenant scope and repeats tenantId into the SQL function', () => {
    expect((source.match(/this\.prisma\.withTenant\(input\.tenantId/g) ?? []).length).toBe(2);
    expect((source.match(/\$\{input\.tenantId\}::uuid/g) ?? []).length).toBe(2);
  });

  test('security partition parameters are passed explicitly, not inferred from session state', () => {
    expect((source.match(/\$\{input\.sensitivity\}/g) ?? []).length).toBe(2);
    expect((source.match(/JSON\.stringify\(input\.accessScope\)/g) ?? []).length).toBe(2);
    expect((source.match(/textArray\(input\.clientRefKeys\)/g) ?? []).length).toBe(2);
  });

  test('repository uses only sanctioned temporal graph functions', () => {
    expect(source).toContain('FROM kg_temporal_walk_bounded(');
    expect(source).toContain('FROM kg_temporal_relation_history(');
    expect(source).not.toMatch(/FROM\s+kg_temporal_assertion_edges/i);
    expect(source).not.toMatch(/FROM\s+knowledge_assertions/i);
  });

  test('no model, resolver, embedding, web, or extractor dependency exists', () => {
    expect(source).not.toMatch(/openai|anthropic|resolver|embedding|extractor|web search/i);
  });
});
