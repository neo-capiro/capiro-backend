import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const root = apiRoot();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Outreach V3 Revised Phase 3 migration contract', () => {
  const conversation = read(
    'prisma/migrations/20261001012000_outreach_v3_reasoning_conversations/migration.sql',
  );
  const claim = read(
    'prisma/migrations/20261001012100_outreach_v3_reasoning_turn_claim/migration.sql',
  );
  const archiveCleanup = read(
    'prisma/migrations/20261001012200_outreach_v3_reasoning_archive_claim_cleanup/migration.sql',
  );
  const combined = `${conversation}\n${claim}\n${archiveCleanup}`;

  it('creates only nonauthoritative Phase 3 conversation/turn tables', () => {
    expect(conversation.match(/CREATE TABLE/g)?.length).toBe(2);
    expect(conversation).toContain('CREATE TABLE "outreach_reasoning_conversations"');
    expect(conversation).toContain('CREATE TABLE "outreach_reasoning_turns"');
    expect(combined).not.toMatch(/CREATE TABLE "(?:outreach_sessions|outreach_state_versions|outreach_events|outreach_command_proposals)"/);
  });

  it('does not mutate legacy Outreach or Phase 2 campaign truth tables', () => {
    for (const table of [
      'outreach_records',
      'outreach_draft_artifacts',
      'outreach_draft_versions',
      'outreach_jobs',
      'outreach_job_items',
      'outreach_send_intents',
      'outreach_deliveries',
      'outreach_sessions',
      'outreach_state_versions',
      'outreach_events',
      'outreach_command_proposals',
    ]) {
      expect(combined).not.toContain(`ALTER TABLE "${table}"`);
      expect(combined).not.toContain(`UPDATE "${table}"`);
      expect(combined).not.toContain(`DELETE FROM "${table}"`);
    }
  });

  it('contains no Campaign Spec copy or hidden-reasoning storage', () => {
    // Strip SQL comments before checking — the migration explicitly states
    // "No hidden reasoning/chain-of-thought field exists" as a comment, which
    // should not trigger the forbidden-pattern check.
    const stripped = combined.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(stripped).not.toMatch(/spec_jsonb|spec_hash|current_state_version|wizard_step|current_stage/i);
    expect(stripped).not.toMatch(/chain.?of.?thought|scratchpad|hidden.?reasoning|reasoning_text|private_reasoning/i);
  });

  it('forces tenant RLS and owner/session binding', () => {
    expect(conversation.match(/FORCE ROW LEVEL SECURITY/g)?.length).toBe(2);
    expect(conversation).toContain('outreach_reasoning_conversations_session_tenant_fkey');
    expect(conversation).toContain('outreach_reasoning_turns_conversation_tenant_fkey');
    expect(conversation).toContain('outreach_reasoning_turns_session_tenant_fkey');
    expect(conversation).toContain('created_by_user_id');
  });

  it('keeps turns append-only and conversation deletion protected', () => {
    expect(conversation).toContain('outreach_reasoning_turns_append_only');
    expect(conversation).toContain('reject_outreach_v3_history_mutation');
    expect(conversation).toContain('outreach_reasoning_conversations_delete_protected');
    expect(conversation).toContain('reject_outreach_v3_delete');
    expect(conversation).toContain('REVOKE UPDATE, DELETE ON "outreach_reasoning_turns" FROM capiro_app');
  });

  it('makes visible provider-state text optional and retains only bounded audit metadata', () => {
    expect(conversation).toContain('"user_message_text" TEXT');
    expect(conversation).toContain('"assistant_message_text" TEXT');
    expect(conversation).not.toContain('"user_message_text" TEXT NOT NULL');
    expect(conversation).not.toContain('"assistant_message_text" TEXT NOT NULL');
    for (const field of [
      'provider_response_id',
      'tool_result_refs_jsonb',
      'proposal_ids_jsonb',
      'open_questions_jsonb',
      'usage_jsonb',
      'latency_ms',
    ]) {
      expect(conversation).toContain(field);
    }
  });

  it('serializes turns with a bounded lease and permits only lease cleanup after archive', () => {
    expect(claim).toContain('in_flight_turn_id');
    expect(claim).toContain('in_flight_started_at');
    expect(claim).toContain('outreach_reasoning_conversations_turn_claim_shape_check');
    expect(archiveCleanup).toContain("IF OLD.status = 'archived'");
    expect(archiveCleanup).toContain('NEW.in_flight_turn_id IS NOT NULL');
    expect(archiveCleanup).toContain('NEW.in_flight_started_at IS NOT NULL');
  });
});
