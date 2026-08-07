import { describe, expect, it } from '@jest/globals';
import {
  ENGAGEMENT_API_UNUSED_CLERK_WEBHOOK_SENTINEL,
  validateEngagementApiConfig,
} from '../../engagement-api/engagement-api-config.js';

function shadowConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/capiro',
    CLERK_SECRET_KEY: 'test-clerk-secret',
    CAPIRO_SERVICE_NAME: 'engagement-api',
    ENGAGEMENT_PROCESS_MODE: 'shadow',
    ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
    ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
    ENGAGEMENT_CALLBACKS_ENABLED: 'false',
    ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
    ...extra,
  };
}

describe('engagement-api config secret minimization', () => {
  it('boots without receiving the Clerk webhook signing secret', () => {
    const parsed = validateEngagementApiConfig(shadowConfig());
    expect(parsed.CLERK_WEBHOOK_SIGNING_SECRET).toBe(
      ENGAGEMENT_API_UNUSED_CLERK_WEBHOOK_SENTINEL,
    );
  });

  it('discards an accidentally supplied real webhook signing secret', () => {
    const parsed = validateEngagementApiConfig(
      shadowConfig({ CLERK_WEBHOOK_SIGNING_SECRET: 'real-secret-that-must-not-survive' }),
    );
    expect(parsed.CLERK_WEBHOOK_SIGNING_SECRET).toBe(
      ENGAGEMENT_API_UNUSED_CLERK_WEBHOOK_SENTINEL,
    );
    expect(parsed.CLERK_WEBHOOK_SIGNING_SECRET).not.toContain('real-secret');
  });
});
