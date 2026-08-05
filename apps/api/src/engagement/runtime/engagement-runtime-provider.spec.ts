import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const engagementModule = readFileSync(
  path.resolve(__dirname, '../engagement.module.ts'),
  'utf8',
);
const mainBootstrap = readFileSync(path.resolve(__dirname, '../../main.ts'), 'utf8');
const engagementBootstrap = readFileSync(
  path.resolve(__dirname, '../../engagement-main.ts'),
  'utf8',
);

describe('Engagement runtime provider and bootstrap wiring', () => {
  it('constructs the policy through an explicit factory rather than class DI', () => {
    expect(engagementModule).toMatch(/provide:\s*EngagementRuntimePolicyService/);
    expect(engagementModule).toMatch(/useFactory:[\s\S]*new EngagementRuntimePolicyService/);
    expect(engagementModule).not.toMatch(/\n\s*EngagementRuntimePolicyService,\s*\n/);
  });

  it('uses the strict environment resolver in the provider', () => {
    expect(engagementModule).toContain('resolveEngagementRuntimeEnvironment');
  });

  it('preflights both bootstraps before NestFactory.create', () => {
    for (const source of [mainBootstrap, engagementBootstrap]) {
      expect(source.indexOf('assertEngagementRuntimeEnvironment')).toBeGreaterThanOrEqual(0);
      expect(source.indexOf('assertEngagementRuntimeEnvironment')).toBeLessThan(
        source.indexOf('NestFactory.create'),
      );
    }
  });
});
