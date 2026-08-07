import type { EngagementRuntimeActionMetadata } from './engagement-runtime-action.decorator.js';

export type EngagementRuntimeRoutePolicy = Readonly<
  Record<string, Readonly<Record<string, Readonly<EngagementRuntimeActionMetadata>>>>
>;

/**
 * Exact controller/handler policy for every Engagement route that always crosses an
 * external boundary or exposes provider credentials.
 *
 * This registry is authoritative at runtime. Method decorators remain useful
 * colocated documentation, but the shadow service does not depend on a
 * decorator being present or on reflect-metadata storage details. The
 * manifest-driven coverage spec proves every external route is represented and
 * every registry entry resolves to a real route.
 *
 * `createDraftVersion` is the one dual-mode entry: the registry keeps its
 * external-generation classification for Improve/malformed requests, while
 * EngagementRuntimeGuard explicitly permits only manual/revert bodies.
 * `openOutreachEmail` is absent because it updates local state and returns a
 * mailto: URL only.
 */
export const ENGAGEMENT_RUNTIME_ROUTE_POLICY = {
  EngagementController: {
    generateDebriefDraft: { action: 'meeting_debrief_generate' },
    dispatchNotetaker: { action: 'notetaker_dispatch' },
    removeNotetaker: { action: 'notetaker_remove' },
    generatePrep: { action: 'meeting_prep_generate' },
    previewAiTemplate: { action: 'outreach_generate' },
    generateTalkingPoints: { action: 'outreach_generate' },
    generateBatchEmails: { action: 'outreach_generate' },
    sendBatchEmails: { action: 'outreach_send' },
    submitGenerateJob: { action: 'outreach_generate' },
    submitSendJob: { action: 'outreach_send' },
    retryOutreachJobItem: { action: 'outreach_generate' },
    createDraftVersion: { action: 'outreach_generate' },
    createSendIntent: { action: 'outreach_send' },
    generateOutreachDraft: { action: 'outreach_generate' },
    sendCampaign: { action: 'outreach_send' },
    createAttachmentUploadUrl: { action: 'attachment_external_write' },
    confirmAttachment: { action: 'attachment_external_write' },
    extractAttachmentText: { action: 'attachment_external_read' },
    deleteAttachment: { action: 'attachment_external_write' },
    generateCampaignEmail: { action: 'outreach_generate' },
    sendCampaignEmails: { action: 'outreach_send' },
    sendCampaignTest: { action: 'outreach_test_send', testMode: true },
  },
  MicrosoftOAuthController: {
    disconnect: { action: 'integration_disconnect' },
    start: { action: 'integration_oauth_start' },
    sync: { action: 'integration_sync' },
    syncCalendarWindow: { action: 'integration_sync' },
    subscriptions: { action: 'integration_subscription' },
    validateGet: { action: 'integration_notification', requiresCallbacks: true },
    notifications: { action: 'integration_notification', requiresCallbacks: true },
    callback: { action: 'integration_oauth_callback', requiresCallbacks: true },
  },
  GoogleOAuthController: {
    syncConnection: { action: 'integration_sync' },
    disconnect: { action: 'integration_disconnect' },
    start: { action: 'integration_oauth_start' },
    callback: { action: 'integration_oauth_callback', requiresCallbacks: true },
  },
  InternalAiCredentialsController: {
    resolve: { action: 'internal_ai_credential_resolve' },
  },
} as const satisfies EngagementRuntimeRoutePolicy;

export function runtimePolicyForHandler(
  controllerName: string,
  handlerName: string,
  registry: EngagementRuntimeRoutePolicy = ENGAGEMENT_RUNTIME_ROUTE_POLICY,
): EngagementRuntimeActionMetadata | undefined {
  return registry[controllerName]?.[handlerName];
}

export function sameRuntimeMetadata(
  left: EngagementRuntimeActionMetadata,
  right: EngagementRuntimeActionMetadata,
): boolean {
  return (
    left.action === right.action &&
    Boolean(left.requiresCallbacks) === Boolean(right.requiresCallbacks) &&
    Boolean(left.testMode) === Boolean(right.testMode)
  );
}

export function registryEntries(
  registry: EngagementRuntimeRoutePolicy = ENGAGEMENT_RUNTIME_ROUTE_POLICY,
): Array<{
  controller: string;
  handler: string;
  metadata: EngagementRuntimeActionMetadata;
}> {
  return Object.entries(registry).flatMap(([controller, handlers]) =>
    Object.entries(handlers).map(([handler, metadata]) => ({ controller, handler, metadata })),
  );
}
