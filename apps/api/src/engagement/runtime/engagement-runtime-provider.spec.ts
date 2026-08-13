import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const engagementModule = readFileSync(
  path.resolve(__dirname, 'engagement-runtime.module.ts'),
  'utf8',
);
const mainBootstrap = readFileSync(path.resolve(__dirname, '../../main.ts'), 'utf8');
const engagementBootstrap = readFileSync(
  path.resolve(__dirname, '../../engagement-main.ts'),
  'utf8',
);

describe('Engagement runtime provider and bootstrap wiring', () => {
  it('constructs the policy through an explicit factory', () => {
    expect(engagementModule).toMatch(/provide:\s*EngagementRuntimePolicyService/);
    expect(engagementModule).toMatch(
      /provide:\s*EngagementRuntimePolicyService,[\s\S]*?useFactory:[\s\S]*?new EngagementRuntimePolicyService/,
    );
  });

  it('uses the strict environment resolver in the provider', () => {
    expect(engagementModule).toContain('resolveEngagementRuntimeEnvironment');
  });

  it('preflights both bootstraps before NestFactory.create', () => {
    for (const source of [mainBootstrap, engagementBootstrap]) {
      const bootstrap = source.slice(source.indexOf('async function bootstrap'));
      const preflightIndex = bootstrap.indexOf('assertEngagementRuntimeEnvironment');
      const nestCreateIndex = bootstrap.indexOf('NestFactory.create');
      expect(preflightIndex).toBeGreaterThanOrEqual(0);
      expect(nestCreateIndex).toBeGreaterThanOrEqual(0);
      expect(preflightIndex).toBeLessThan(nestCreateIndex);
    }
  });
});
