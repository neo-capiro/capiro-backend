import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { jevTaskEvaluationFixtureSchema } from './task-evaluation-fixture';

describe('Jev task evaluation fixture compatibility', () => {
  const fixturePath = path.join(__dirname, '__fixtures__', 'package2-task-evaluation-v1.json');
  const historicalFixture = () =>
    JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

  it('keeps the immutable v4 Package 2 replay fixture readable after the v5 registry bump', () => {
    const parsed = jevTaskEvaluationFixtureSchema.parse(historicalFixture());

    expect(parsed.registryVersion).toBe('jev-task-registry.v4');
    expect(parsed.cases.length).toBeGreaterThan(0);
  });

  it('accepts the current registry version for newly recorded fixtures', () => {
    const fixture = {
      ...historicalFixture(),
      registryVersion: 'jev-task-registry.v5',
    };

    expect(jevTaskEvaluationFixtureSchema.parse(fixture).registryVersion).toBe(
      'jev-task-registry.v5',
    );
  });
});
