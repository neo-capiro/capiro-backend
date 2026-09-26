import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve(
  __dirname,
  '../../../prisma/migrations/20280928120000_meri_phase4_clarification_effect/migration.sql',
), 'utf8');
const compact = migration.replace(/\s+/g, ' ').trim();

describe('Phase 4 clarification broker-effect migration', () => {
  it('extends the one global operation namespace as a tool-discriminated union', () => {
    expect(compact).toContain('ADD COLUMN clarification_question text');
    expect(compact).toContain('ADD COLUMN clarification_choices_jsonb jsonb');
    expect(compact).toContain('ADD COLUMN clarification_multi_select boolean');
    expect(compact).toContain("tool_name IN ('meri_record_turn', 'meri_request_clarification')");
    expect(compact).toContain("domain_ref = 'clar_' || operation_id::text");
    expect(migration).not.toMatch(/CREATE TABLE public\.meri_phase4_clarification/i);
  });

  it('uses one fixed canonical request and deterministic public request id', () => {
    expect(compact).toContain("v_request_id varchar(120) := 'clar_' || p_operation_id::text");
    expect(compact).toContain("'capiro.meri.phase4.broker-effect-request/v1'");
    expect(compact).toContain("p_scope_id, 'meri_request_clarification', p_question");
    expect(compact).toContain("jsonb_array_length(p_choices)::text ] || v_choice_parts");
    expect(compact).toContain("char_length(v_choice_text) NOT BETWEEN 1 AND 2000");
  });

  it('serializes global operation replay before current state and excludes disposition from identity', () => {
    expect(compact).toContain(
      'pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtextextended(p_operation_id::text, 0) )',
    );
    const clarification = compact.slice(
      compact.indexOf('CREATE FUNCTION public.meri_phase4_request_clarification_effect'),
      compact.indexOf('ALTER FUNCTION public.meri_phase4_request_clarification_effect'),
    );
    expect(clarification.indexOf('FROM public.meri_phase4_broker_effect_operations o'))
      .toBeLessThan(clarification.indexOf('FROM public.meri_phase4_authority_fences f'));
    const replayIdentity = clarification.slice(
      clarification.indexOf('IF ROW('), clarification.indexOf(') THEN', clarification.indexOf('IF ROW(')),
    );
    expect(replayIdentity).not.toContain('effect_disposition');
    expect(clarification).toContain("RAISE EXCEPTION 'Phase 4 clarification operation replay drift'");
    expect(clarification).toContain('receipt_id := v_existing_receipt.receipt_id');
  });

  it('keeps caller uncertainty unsigned and ahead of current authority and Stop classification', () => {
    expect(compact).toContain("IF p_effect_disposition <> 'effect_unknown' THEN SELECT f.* INTO v_fence");
    expect(compact).toContain("IF p_effect_disposition = 'effect_unknown' THEN v_result := 'effect_unknown'");
    const clarification = compact.slice(
      compact.indexOf('CREATE FUNCTION public.meri_phase4_request_clarification_effect'),
      compact.indexOf('ALTER FUNCTION public.meri_phase4_request_clarification_effect'),
    );
    expect(clarification.indexOf("IF p_effect_disposition = 'effect_unknown'"))
      .toBeLessThan(clarification.indexOf("v_run.stop_requested_at IS NOT NULL"));
    expect(compact).toContain("IF v_result <> 'effect_unknown' THEN SELECT a.* INTO v_attestation");
    expect(compact).toContain("result = 'effect_unknown'");
    expect(compact).toContain('signer_key_id IS NULL AND signature IS NULL');
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
    expect(compact).toContain("jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,readOnly}') = 'boolean' THEN");
    expect(compact).not.toContain("#> '{toolPolicy,readOnly}' = 'false'::jsonb");
    expect(compact).toContain('v_cap IS NULL OR v_cap < 0 OR v_cap > 40');
    expect(compact).toContain('v_cap BETWEEN 0 AND 40');
  });

  it('atomically publishes one interaction, public event, waiting status, and receipt', () => {
    expect(compact).toContain("status = 'waiting_for_clarification'");
    expect(compact).toContain('INSERT INTO public.meri_agent_interactions');
    expect(compact).toContain("'clarification', 'durable_continuation'");
    expect(compact).toContain("'clarification.requested', 'public'");
    expect(compact).toContain("'brokerEffectOperationId', p_operation_id");
    expect(compact).toContain('INSERT INTO public.meri_phase4_broker_effect_receipts');
  });

  it('replaces record-turn with the four corrected cross-tool invariants', () => {
    const recordTurn = compact.slice(
      compact.indexOf('CREATE OR REPLACE FUNCTION public.meri_phase4_record_turn_effect'),
      compact.lastIndexOf('REVOKE CREATE ON SCHEMA public'),
    );
    expect(recordTurn).toContain("jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,readOnly}') = 'boolean' THEN");
    expect(recordTurn).not.toContain("#> '{toolPolicy,readOnly}' = 'false'::jsonb");
    expect(recordTurn).toContain('v_cap IS NULL OR v_cap < 0 OR v_cap > 40');
    const replayIdentity = recordTurn.slice(
      recordTurn.indexOf('IF ROW('), recordTurn.indexOf(') THEN', recordTurn.indexOf('IF ROW(')),
    );
    expect(replayIdentity).not.toContain('effect_disposition');
    expect(recordTurn.indexOf("IF p_effect_disposition = 'effect_unknown'"))
      .toBeLessThan(recordTurn.indexOf("v_run.stop_requested_at IS NOT NULL"));
  });

  it('exposes execute-only authority and removes temporary role membership', () => {
    expect(compact).toContain(
      'CREATE POLICY meri_p4_clarification_interaction_owner ON public.meri_agent_interactions FOR INSERT',
    );
    expect(compact).toContain('GRANT UPDATE (status) ON TABLE public.meri_agent_runs');
    expect(compact).toContain('GRANT INSERT ( run_id,request_id,kind,continuation,prompt,choices_jsonb,multi_select, created_at,expires_at,resolution_jsonb ) ON TABLE public.meri_agent_interactions');
    expect(compact).toContain('TO meri_phase4_broker_effect_operator');
    expect(compact).toContain("REVOKE meri_phase4_authority_owner FROM %I");
    expect(compact.endsWith('COMMIT;')).toBe(true);
  });
});
