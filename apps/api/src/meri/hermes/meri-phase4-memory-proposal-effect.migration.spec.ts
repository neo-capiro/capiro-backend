import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve(
  __dirname,
  '../../../prisma/migrations/20280928130000_meri_phase4_memory_proposal_effect/migration.sql',
), 'utf8');
const compact = migration.replace(/\s+/g, ' ').trim();

describe('Phase 4 memory-proposal broker-effect migration', () => {
  it('extends the one global operation namespace as a tool-discriminated union', () => {
    expect(compact).toContain('ADD COLUMN memory_key varchar');
    expect(compact).toContain('ADD COLUMN memory_value_sha256 char(64)');
    expect(compact).toContain('ADD COLUMN memory_scope varchar(16)');
    expect(compact).toContain('ADD COLUMN memory_client_id uuid');
    expect(compact).toContain('ADD COLUMN memory_confidence float8');
    expect(compact).toContain('ADD COLUMN memory_source_excerpt_length integer');
    expect(compact).toContain(
      "tool_name IN ('meri_record_turn', 'meri_request_clarification', 'meri_propose_memory')",
    );
    expect(compact).toContain("domain_ref = 'memcand_' || operation_id::text");
    expect(migration).not.toMatch(/CREATE TABLE public\.meri_phase4_memory_proposal/i);
  });

  it('uses IEEE-754 float8send for confidence in the canonical request digest', () => {
    expect(compact).toContain("'capiro.meri.phase4.broker-effect-request/v1'");
    expect(compact).toContain("'meri_propose_memory', btrim(p_key), btrim(p_value)");
    expect(compact).toContain(
      "CASE WHEN p_confidence IS NULL THEN 'null' ELSE encode(float8send(p_confidence), 'hex') END",
    );
    expect(compact).toContain("coalesce(left(p_source_excerpt, 4000), 'null')");
  });

  it('serializes global operation replay before current state and excludes disposition from identity', () => {
    expect(compact).toContain(
      'pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtextextended(p_operation_id::text, 0) )',
    );
    const memoryProposal = compact.slice(
      compact.indexOf('CREATE FUNCTION public.meri_phase4_propose_memory_effect'),
      compact.indexOf('ALTER FUNCTION public.meri_phase4_propose_memory_effect'),
    );
    expect(memoryProposal.indexOf('FROM public.meri_phase4_broker_effect_operations o'))
      .toBeLessThan(memoryProposal.indexOf('FROM public.meri_phase4_authority_fences f'));
    const replayIdentity = memoryProposal.slice(
      memoryProposal.indexOf('IF ROW('),
      memoryProposal.indexOf(') THEN', memoryProposal.indexOf('IF ROW(')),
    );
    expect(replayIdentity).not.toContain('effect_disposition');
    expect(memoryProposal).toContain(
      "RAISE EXCEPTION 'Phase 4 memory proposal operation replay drift'",
    );
    expect(memoryProposal).toContain('receipt_id := v_existing_receipt.receipt_id');
  });

  it('keeps caller uncertainty unsigned and ahead of current authority and Stop classification', () => {
    expect(compact).toContain(
      "IF p_effect_disposition <> 'effect_unknown' THEN SELECT f.* INTO v_fence",
    );
    expect(compact).toContain(
      "IF p_effect_disposition = 'effect_unknown' THEN v_result := 'effect_unknown'",
    );
    const memoryProposal = compact.slice(
      compact.indexOf('CREATE FUNCTION public.meri_phase4_propose_memory_effect'),
      compact.indexOf('ALTER FUNCTION public.meri_phase4_propose_memory_effect'),
    );
    expect(memoryProposal.indexOf("IF p_effect_disposition = 'effect_unknown'"))
      .toBeLessThan(memoryProposal.indexOf('v_run.stop_requested_at IS NOT NULL'));
    expect(compact).toContain(
      "IF v_result <> 'effect_unknown' THEN SELECT a.* INTO v_attestation",
    );
  });

  it('holds the authority/run/route fences and permits run-local tools on read-only runs', () => {
    expect(compact).toContain(
      'FROM public.meri_phase4_authority_fences f WHERE f.tenant_id = p_tenant_id FOR SHARE',
    );
    expect(compact).toContain(
      'FROM public.meri_agent_runs r WHERE r.tenant_id = p_tenant_id AND r.id = p_run_id FOR UPDATE',
    );
    expect(compact).toContain('FROM public.meri_phase4_worker_routes r');
    expect(compact).toContain('FROM public.meri_phase4_worker_bindings b');
    expect(compact).toContain(
      "jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,readOnly}') = 'boolean' THEN",
    );
    expect(compact).not.toContain("#> '{toolPolicy,readOnly}' = 'false'::jsonb");
    expect(compact).toContain('v_cap IS NULL OR v_cap < 0 OR v_cap > 40');
    expect(compact).toContain('v_cap BETWEEN 0 AND 40');
  });

  it('atomically publishes one memory_candidate, conditional review_request, event, and receipt', () => {
    expect(compact).toContain('INSERT INTO public.memory_candidate');
    expect(compact).toContain("'model_extraction'");
    expect(compact).toContain("'memory.proposed', 'internal'");
    expect(compact).toContain("'brokerEffectOperationId', p_operation_id");
    expect(compact).toContain('INSERT INTO public.review_request');
    expect(compact).toContain("p_scope IN ('firm', 'client')");
    expect(compact).toContain('INSERT INTO public.meri_phase4_broker_effect_receipts');
    expect(compact).not.toContain("status = 'waiting_for_clarification'");
  });

  it('validates scope/clientId constraints before budget reservation', () => {
    expect(compact).toContain("p_scope NOT IN ('personal', 'firm', 'client')");
    expect(compact).toContain("(p_scope = 'client' AND p_client_id IS NULL)");
    expect(compact).toContain("(p_scope <> 'client' AND p_client_id IS NOT NULL)");
  });

  it('exposes execute-only authority and removes temporary role membership', () => {
    expect(compact).toContain(
      'CREATE POLICY meri_p4_memory_candidate_insert_owner ON public.memory_candidate FOR INSERT',
    );
    expect(compact).toContain(
      'CREATE POLICY meri_p4_review_request_insert_owner ON public.review_request FOR INSERT',
    );
    expect(compact).toContain('TO meri_phase4_broker_effect_operator');
    expect(compact).toContain("REVOKE meri_phase4_authority_owner FROM %I");
    expect(compact.endsWith('COMMIT;')).toBe(true);
  });
});
