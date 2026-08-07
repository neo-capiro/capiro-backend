import { validateConfig, type AppConfig } from '../config/config.schema.js';

/**
 * The shared application schema historically requires the Clerk webhook secret
 * for the main API. engagement-api intentionally does not import WebhooksModule,
 * so injecting that live secret widened blast radius without enabling a route.
 *
 * Use a fixed nonsecret sentinel only while validating this service's config.
 * Any accidentally supplied real value is discarded before ConfigService sees
 * it. IAM/template tests independently prove the task receives no such secret.
 */
export const ENGAGEMENT_API_UNUSED_CLERK_WEBHOOK_SENTINEL =
  'engagement-api-no-clerk-webhook-module';

export function validateEngagementApiConfig(
  raw: Record<string, unknown>,
): AppConfig {
  return validateConfig({
    ...raw,
    CLERK_WEBHOOK_SIGNING_SECRET: ENGAGEMENT_API_UNUSED_CLERK_WEBHOOK_SENTINEL,
  });
}
