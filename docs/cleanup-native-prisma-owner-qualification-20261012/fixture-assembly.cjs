'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, verifyBindings } = require('./canonical-native-loader.cjs');
const api = 'apps/api/prisma/migrations/';
const ws = 'apps/workspace/prisma/migrations/';
function source(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8'); }
function between(value, start, end) {
  const first = value.indexOf(start);
  const last = end == null ? value.length : value.indexOf(end, first + start.length);
  if (first < 0 || last < 0 || value.indexOf(start, first + start.length) !== -1)
    throw new Error(`Ambiguous fixture source boundary: ${start}`);
  return value.slice(first, last);
}
function assembleFixture() {
  verifyBindings();
  const parts = [{ source: 'parent-fixture.sql', sql: fs.readFileSync(path.join(__dirname, 'parent-fixture.sql'), 'utf8'), qualification: 'minimal final-shape parents' }];
  const identity = source(api + '20260501000000_init_identity_tenancy/migration.sql');
  parts.push({ source: api + '20260501000000_init_identity_tenancy/migration.sql', qualification: 'exact functions and tenant/member policies, not entire migration', sql: between(identity, 'CREATE OR REPLACE FUNCTION current_tenant_id()', '-- audit_logs:') });
  const clients = source(api + '20260502000000_user_admin_brand_clients/migration.sql');
  parts.push({ source: api + '20260502000000_user_admin_brand_clients/migration.sql', qualification: 'exact client policy/grants', sql: between(clients, 'ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;', null) });
  const wallPath = api + '20260719220000_client_memory_walls/migration.sql';
  parts.push({ source: wallPath, qualification: 'exact additive wall/table/policy/grants before unrelated embedding backfill', sql: between(source(wallPath), '-- 1. The wall flag.', '-- 3. context_embeddings.client_id') });
  for (const name of [
    api + '20281011010000_client_objectives/migration.sql',
    api + '20260908010000_outreach_v3_campaign_state/migration.sql',
    ws + '00000000000000_init_workspace/migration.sql',
    ws + '20260627185725_ws_doc_version/migration.sql',
    ws + '20260627190000_ws_collaborator/migration.sql',
    ws + '20260913020000_legiwatch_preparation_actions/migration.sql',
    ws + '20261012030000_prospect_resource_origin/migration.sql',
    ws + '20261012040000_saved_version_immutability/migration.sql',
  ]) parts.push({ source: name, qualification: 'whole exact reviewed migration', sql: source(name) });
  const fr = api + '20260521030000_intel_optimization/migration.sql';
  parts.push({ source: fr, qualification: 'exact Federal Register base before unrelated Congress tables', sql: between(source(fr), '-- CreateTable: federal_register_document', '-- CreateTable: congress_bill_action') });
  const run = api + '20260523080000_sync_run_table/migration.sql';
  parts.push({ source: run, qualification: 'whole exact reviewed migration', sql: source(run) });
  const stats = api + '20280921000100_federal_award_date_semantics/migration.sql';
  parts.push({ source: stats, qualification: 'exact SyncRun stats addition before unrelated award columns', sql: between(source(stats), 'ALTER TABLE "sync_run"', 'ALTER TABLE "federal_award"') });
  const effective = api + '20281012060000_federal_register_effective_evidence/migration.sql';
  parts.push({ source: effective, qualification: 'whole exact reviewed migration', sql: source(effective) });
  for (const name of [
    '20261007010000_newsletter_outreach_format', '20261007020000_newsletter_review_email_delivery',
    '20261007030000_newsletter_invitation_email_delivery', '20261007040000_newsletter_account_invitations',
  ]) parts.push({ source: api + name + '/migration.sql', qualification: 'whole exact Core rich newsletter migration; synthetic legacy parent only', sql: source(api + name + '/migration.sql') });
  parts.push({ source: 'explicit fixture grants', qualification: 'test prerequisite only; does not assert deployed Workspace grants', sql: `
GRANT SELECT,INSERT,UPDATE,DELETE ON tenants,users,tenant_memberships TO capiro_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ws_draft,ws_document,ws_context_item,ws_template,ws_comment,ws_doc_version,ws_collaborator TO capiro_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON federal_register_document,sync_run TO capiro_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ws_prospect_draft_receipt TO capiro_app;
` });
  return parts;
}
module.exports = { assembleFixture, between };
