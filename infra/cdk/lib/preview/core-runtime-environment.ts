/** Existing owners read these switches; this module introduces no runtime policy. */
export function previewCoreRuntimeEnvironment(): Record<string, string> {
  return {
    CAPIRO_SERVICE_NAME: 'api',
    ENGAGEMENT_PROCESS_MODE: 'shadow',
    ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
    ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
    ENGAGEMENT_CALLBACKS_ENABLED: 'false',
    ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
    ENGAGEMENT_AUTO_SYNC: 'false',
    SAM_ENRICHMENT_ENABLED: 'false',
    NOTETAKER_ENABLED: 'false',
    CLIENT_PROFILE_FILL_WORKER_ENABLED: 'false',
    CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED: 'false',
    RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED: 'false',
    NEWSLETTER_REVIEW_EMAIL_ENABLED: 'false',
    NEWSLETTER_INVITATION_EMAIL_ENABLED: 'false',
    MERI_JOB_SWEEPER_ENABLED: 'false',
    OUTREACH_V3_REASONING_ENABLED: 'false',
    OUTREACH_V3_GENERATION_ENABLED: 'false',
    OUTREACH_V3_FULL_GENERATION_ENABLED: 'false',
    OUTREACH_V3_SEND_ENABLED: 'false',
  };
}
