/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Primary source:
 *   apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json
 * Additive Outreach V3 sources:
 *   apps\api\src\outreach-v3\__fixtures__\outreach-v3-route-manifest.v1.json
 *   apps\api\src\outreach-v3\__fixtures__\outreach-v3-reasoning-route-manifest.v1.json
 *   apps\api\src\outreach-v3\__fixtures__\outreach-v3-target-route-manifest.v1.json
 *   apps\api\src\outreach-v3\__fixtures__\outreach-v3-context-route-manifest.v1.json
 * Generator: scripts/engagement-phase3-preview-route-patterns.mjs
 * Regenerate: node scripts/engagement-phase3-preview-route-patterns.mjs --write
 *
 * Anchored path patterns for every accepted browser route owned by the
 * engagement-api runtime. The preview header name remains isolated in
 * engagement-api-preview.ts. Prefix or substring matching is prohibited.
 *
 * Deliberately excluded primary-manifest paths:
 *   /api/internal/ai-credentials/resolve
 *     Service-to-service credential resolve. Not called from the browser and outside the ALB preview rule path condition.
 *   /webhooks/recall
 *     Recall.ai inbound webhook. Called by Recall, never by the SPA, and not owned by preview routing.
 */

/** sha256 of the primary Engagement parity manifest. */
export const ENGAGEMENT_ROUTE_MANIFEST_SHA256 =
  '1c3ff0922302e8b26048886c777f957ca9938081e71bd7255fc696d33e15b187';

/** Primary manifest schema version. */
export const ENGAGEMENT_ROUTE_MANIFEST_SCHEMA_VERSION = 1;

/** Distinct primary + additive manifest paths covered below. */
export const ENGAGEMENT_PREVIEW_ROUTE_COUNT = 111;

export const ENGAGEMENT_PREVIEW_ROUTE_PATTERNS: readonly string[] = [
  '^/api/engagement/associations/override$',
  '^/api/engagement/attachments$',
  '^/api/engagement/attachments/[^/]+$',
  '^/api/engagement/attachments/[^/]+/extract-text$',
  '^/api/engagement/attachments/confirm$',
  '^/api/engagement/attachments/upload-url$',
  '^/api/engagement/campaigns$',
  '^/api/engagement/campaigns/[^/]+$',
  '^/api/engagement/campaigns/[^/]+/generate$',
  '^/api/engagement/campaigns/[^/]+/recipients$',
  '^/api/engagement/campaigns/[^/]+/recipients/[^/]+$',
  '^/api/engagement/campaigns/[^/]+/send$',
  '^/api/engagement/campaigns/[^/]+/send-test$',
  '^/api/engagement/capabilities$',
  '^/api/engagement/contacts$',
  '^/api/engagement/context/[^/]+$',
  '^/api/engagement/debriefs$',
  '^/api/engagement/integrations$',
  '^/api/engagement/integrations/google/[^/]+$',
  '^/api/engagement/integrations/google/[^/]+/sync$',
  '^/api/engagement/integrations/google/callback$',
  '^/api/engagement/integrations/google/capabilities$',
  '^/api/engagement/integrations/google/start$',
  '^/api/engagement/integrations/microsoft/[^/]+$',
  '^/api/engagement/integrations/microsoft/[^/]+/calendar-window$',
  '^/api/engagement/integrations/microsoft/[^/]+/subscriptions$',
  '^/api/engagement/integrations/microsoft/[^/]+/sync$',
  '^/api/engagement/integrations/microsoft/callback$',
  '^/api/engagement/integrations/microsoft/capabilities$',
  '^/api/engagement/integrations/microsoft/notifications$',
  '^/api/engagement/integrations/microsoft/start$',
  '^/api/engagement/mail-threads$',
  '^/api/engagement/meeting-preps/[^/]+$',
  '^/api/engagement/meeting-preps/[^/]+/approve$',
  '^/api/engagement/meetings$',
  '^/api/engagement/meetings/[^/]+$',
  '^/api/engagement/meetings/[^/]+/artifacts/share$',
  '^/api/engagement/meetings/[^/]+/artifacts/unshare$',
  '^/api/engagement/meetings/[^/]+/attachments/[^/]+/approve$',
  '^/api/engagement/meetings/[^/]+/debrief-draft$',
  '^/api/engagement/meetings/[^/]+/debriefs$',
  '^/api/engagement/meetings/[^/]+/debriefs/[^/]+$',
  '^/api/engagement/meetings/[^/]+/debriefs/[^/]+/approve$',
  '^/api/engagement/meetings/[^/]+/notes$',
  '^/api/engagement/meetings/[^/]+/notes/[^/]+$',
  '^/api/engagement/meetings/[^/]+/notes/[^/]+/approve$',
  '^/api/engagement/meetings/[^/]+/notetaker$',
  '^/api/engagement/meetings/[^/]+/prep$',
  '^/api/engagement/meetings/[^/]+/share$',
  '^/api/engagement/meetings/[^/]+/unshare$',
  '^/api/engagement/meetings/library$',
  '^/api/engagement/outcomes$',
  '^/api/engagement/outreach$',
  '^/api/engagement/outreach-v3/reasoning/conversations/[^/]+$',
  '^/api/engagement/outreach-v3/reasoning/conversations/[^/]+/archive$',
  '^/api/engagement/outreach-v3/reasoning/conversations/[^/]+/turns$',
  '^/api/engagement/outreach-v3/sessions$',
  '^/api/engagement/outreach-v3/sessions/[^/]+$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/archive$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/commands$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/context/document$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/context/government/search$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/context/memory/search$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/context/review$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/context/strategy$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/events$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/proposals$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/proposals/[^/]+/apply$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/proposals/[^/]+/reject$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/reasoning/conversations$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/targets/coverage$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/targets/profile$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/targets/relationships$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/targets/search$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/versions$',
  '^/api/engagement/outreach-v3/sessions/[^/]+/versions/[^/]+$',
  '^/api/engagement/outreach/[^/]+$',
  '^/api/engagement/outreach/[^/]+/generate-draft$',
  '^/api/engagement/outreach/[^/]+/open-email$',
  '^/api/engagement/outreach/[^/]+/restore$',
  '^/api/engagement/outreach/[^/]+/send-campaign$',
  '^/api/engagement/outreach/[^/]+/draft-artifacts$',
  '^/api/engagement/outreach/ai-templates$',
  '^/api/engagement/outreach/ai-templates/[^/]+$',
  '^/api/engagement/outreach/ai-templates/[^/]+/preview$',
  '^/api/engagement/outreach/audiences$',
  '^/api/engagement/outreach/context-library$',
  '^/api/engagement/outreach/draft-artifacts/[^/]+/versions$',
  '^/api/engagement/outreach/draft-artifacts/[^/]+/versions/[^/]+/accept$',
  '^/api/engagement/outreach/draft-versions/[^/]+$',
  '^/api/engagement/outreach/generate-batch$',
  '^/api/engagement/outreach/insights$',
  '^/api/engagement/outreach/insights/talking-points$',
  '^/api/engagement/outreach/jobs/[^/]+$',
  '^/api/engagement/outreach/jobs/[^/]+/cancel$',
  '^/api/engagement/outreach/jobs/[^/]+/items/[^/]+/retry$',
  '^/api/engagement/outreach/jobs/generate$',
  '^/api/engagement/outreach/jobs/send$',
  '^/api/engagement/outreach/outbound/contact-data$',
  '^/api/engagement/outreach/prior-contact$',
  '^/api/engagement/outreach/send-batch$',
  '^/api/engagement/outreach/send-intents$',
  '^/api/engagement/outreach/send-intents/[^/]+$',
  '^/api/engagement/outreach/send-intents/[^/]+/cancel$',
  '^/api/engagement/outreach/templates$',
  '^/api/engagement/reports/overview$',
  '^/api/engagement/reports/target-offices$',
  '^/api/engagement/reports/target-offices/overrides$',
  '^/api/engagement/shared-meetings$',
  '^/api/engagement/tasks$',
  '^/api/engagement/tasks/[^/]+$',
];
