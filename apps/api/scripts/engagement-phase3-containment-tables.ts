#!/usr/bin/env tsx
/** Pure table-scope contract for the Phase 3 external-action denial sweep. */

const BUSINESS_PREFIXES = [
  'engagement_',
  'outreach_',
  'meeting_',
  'mail_',
  'compliance_',
  'assurance_',
] as const;

const BUSINESS_EXACT = new Set([
  'meetings',
  'clients',
  'ai_runs',
  'ai_usage_events',
  'meri_audit_ledger',
  'audit_logs',
  'tenant_usage_meters',
  'context_packets',
  'outcome_events',
  'review_requests',
  'alert_generation_records',
]);

/**
 * Tables whose tenant-scoped rows must remain byte-for-byte unchanged while a
 * shadow external action is refused. This deliberately includes immutable
 * draft/version rows and AI/audit/usage tables: a provider call is not the only
 * side effect Phase 3 must prevent.
 */
export function isPhase3ProtectedSideEffectTable(tableName: string): boolean {
  if (BUSINESS_EXACT.has(tableName)) return true;
  return BUSINESS_PREFIXES.some((prefix) => tableName.startsWith(prefix));
}

export const PHASE3_REQUIRED_CONTAINMENT_TABLES = [
  'outreach_jobs',
  'outreach_draft_artifacts',
  'outreach_draft_versions',
  'outreach_send_intents',
  'outreach_deliveries',
  'meeting_bot_sessions',
  'engagement_connections',
  'engagement_connection_tokens',
  'engagement_attachments',
  'ai_runs',
  'ai_usage_events',
  'meri_audit_ledger',
] as const;
