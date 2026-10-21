import { z } from 'zod';
import { configSchema, type AppConfig } from '../config/config.schema.js';

const previewSchema = z.object({
  CAPIRO_PREVIEW_READONLY: z.literal('true'),
  PREVIEW_READONLY_DATABASE_URL: z.string().url().refine(
    (url) => ['postgres:', 'postgresql:'].includes(new URL(url).protocol),
  ),
  PREVIEW_TENANT_ID: z.string().uuid(),
  PREVIEW_CLERK_ORG_ID: z.string().regex(/^org_[A-Za-z0-9]+$/),
  CLERK_JWT_ISSUER: z.string().url().refine((url) => new URL(url).protocol === 'https:'),
});

export function previewConfig(raw: Record<string, unknown>) {
  const preview = previewSchema.parse(raw);
  // No webhook receiver is registered. Reuse canonical feature defaults, while
  // excluding webhook signing input rather than supplying a fake secret.
  const app = configSchema.omit({ CLERK_WEBHOOK_SIGNING_SECRET: true }).parse({
    ...raw, DATABASE_URL: preview.PREVIEW_READONLY_DATABASE_URL,
  });
  return { preview, app: app as AppConfig };
}
export type PreviewConfig = ReturnType<typeof previewConfig>;
export const PREVIEW_CONFIG = Symbol('PREVIEW_CONFIG');
