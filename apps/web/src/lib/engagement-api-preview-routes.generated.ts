/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json
 * Generator: scripts/engagement-phase3-preview-route-patterns.mjs
 * Regenerate: node scripts/engagement-phase3-preview-route-patterns.mjs --write
 *
 * Anchored path patterns for every accepted Engagement route the browser may
 * send the Engagement API preview header to. (The header name itself lives in
 * engagement-api-preview.ts — the one module allowed to spell it.) Anchored on
 * purpose: substring matching would send the header to look-alike paths the ALB
 * preview rule does not cover, and would not notice a renamed route.
 *
 * Deliberately excluded manifest paths:
 *   /api/internal/ai-credentials/resolve
 *     Service-to-service credential resolve. Not called from the browser (no web consumer in the 3.1 inventory) and outside the ALB preview rule path condition. Phase 4 owns this boundary.
 *   /webhooks/recall
 *     Recall.ai inbound webhook. Called by Recall, never by the SPA, and Phase 3 explicitly does not move callback traffic.
 */

/** sha256 of the route manifest these patterns were generated from. */
export const ENGAGEMENT_ROUTE_MANIFEST_SHA256 =
  'ee29d309f53be496b6b6d1cb3c35d9391eb772cd752f12ecadc04c3524278c7c';

/** Manifest schema version these patterns were generated from. */
export const ENGAGEMENT_ROUTE_MANIFEST_SCHEMA_VERSION = 1;

/** Distinct manifest paths covered by the patterns below. */
export const ENGAGEMENT_PREVIEW_ROUTE_COUNT = 88;

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
