import {
  PHASE3_REQUIRED_CONTAINMENT_TABLES,
  isPhase3ProtectedSideEffectTable,
} from './engagement-phase3-containment-tables.js';

describe('Phase 3 external-action containment table scope', () => {
  test.each(PHASE3_REQUIRED_CONTAINMENT_TABLES)('protects %s', (table) => {
    expect(isPhase3ProtectedSideEffectTable(table)).toBe(true);
  });

  test.each([
    'outreach_ai_template',
    'outreach_audiences',
    'engagement_report_target_offices',
    'meeting_notes',
    'meeting_debriefs',
    'mail_threads',
    'compliance_policy_decisions',
    'assurance_eval_runs',
    'context_packets',
    'tenant_usage_meters',
  ])('protects side-effect-bearing table %s', (table) => {
    expect(isPhase3ProtectedSideEffectTable(table)).toBe(true);
  });

  test.each([
    'tenants',
    'users',
    'tenant_memberships',
    'program_elements',
    'bills',
    '_prisma_migrations',
  ])('does not widen the denial digest to unrelated table %s', (table) => {
    expect(isPhase3ProtectedSideEffectTable(table)).toBe(false);
  });

  test('negative control: generated-success persistence cannot be dropped silently', () => {
    for (const table of [
      'outreach_draft_artifacts',
      'outreach_draft_versions',
      'ai_runs',
      'ai_usage_events',
      'meri_audit_ledger',
    ]) {
      expect(isPhase3ProtectedSideEffectTable(table), table).toBe(true);
    }
  });
});
