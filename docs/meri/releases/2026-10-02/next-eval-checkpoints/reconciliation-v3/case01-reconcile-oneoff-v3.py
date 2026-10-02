"""One fixed, read-only canonical reconciliation task for the failed case01 setup.

Reuses the exact reviewed one-off lifecycle. No generic command/script/input,
provider credential, registration retry, setup mutation or service update exists.
"""
import argparse, copy, importlib.util, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent
BASE = ROOT / 'case01-oneoff.py'
BASE_SHA = '4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
SCRIPT = ROOT / 'case01-reconcile-readonly-v3.mjs'
SCRIPT_SHA = 'a5d6f35aa1e0df5bbab5fb4de601ced1152300494d59b6f2eb52bb070f031565'
INPUT = ROOT / 'setup-execute-input.json'
INPUT_SHA = '2abd45698d1ca98629e060178b702a21bfe0c7c56ec790258f6e1653aab5ab8c'
FAILED = ROOT / 'setup-execute-execution.json'
FAILED_SHA = '391f4e6afb7026847745c4503f10a520b6196309be54c37724fddd0f8d242b93'
TLS_FAILED = ROOT / 'case01-reconcile-execution.json'
TLS_FAILED_SHA = '018f191b71be80a1f702c794f2b02d1a564fff06cdfcbb33a966a0a52a52519b'
PREVIOUS = ROOT / 'case01-reconcile-v2-execution.json'
PREVIOUS_SHA = 'eacb97719a59814e4ea09019513abc15f292ca6edbc77de125d1289205342aad'
SOURCE = 'c11c83fe1759183254b24d11a9087ccc89595a73'
MODE = 'reconcile-read'
FAMILY = 'capiro-dev-meri-case01-reconcile'
CONTAINER = 'meri-case01-reconcile'
VARIABLE = 'MERI_CASE01_RECONCILE_INPUT'
PREFIX = 'MERI_CASE01_RECONCILE_RECEIPT '
PREDICATES = frozenset('id tenant_id proposed_by status governed_status source_kind source_type source_id scope client_id legal_hold instructions_allowed memory_class memory_authority approved_at approved_by_user_id second_approved_at second_approved_by_user_id decided_at decided_by committed_memory_id committed_memory_item_id revision_root_id predecessor_candidate_id superseded_by_id revision_number duplicate_of_id contradicts_id duplicate_memory_item_id contradicts_memory_item_id conflict_status conflict_group_id confidence memory_scope sensitivity source_ref source_excerpt source_content_hash source_version asserted_by_user_id as_of effective_from valid_until expires_at review_cadence_days review_due_at controlling_item_id retention_policy_jsonb origin_surface origin_trace_id origin_context_packet_id origin_model origin_prompt_version payload_jsonb provenance_jsonb'.split())
AUTH_BASES = frozenset(['owner','tenant_read','explicit_grant','admin'])
AUTH_REASONS = frozenset(['revoked_or_terminal','legal_hold','not_owner','ethical_wall','wrong_client_scope','archived_client','missing_grant','admin_required','self_review','unsupported_operation'])


def load_operator():
    import hashlib
    if hashlib.sha256(BASE.read_bytes()).hexdigest() != BASE_SHA:
        raise RuntimeError('REVIEWED_ONEOFF_CHANGED')
    spec = importlib.util.spec_from_file_location('reviewed_case01_reconcile_base', BASE)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    original_source_check = m.source_check
    original_task_request = m.task_request
    original_qualify = m.qualify
    # The inherited plan self hash now binds this complete fixed composition.
    # The original lifecycle source is separately pinned above and before writes.
    m.__file__ = __file__
    m.FAMILY, m.CONTAINER = FAMILY, CONTAINER
    m.MODES = {MODE: ('node', 'read-only', VARIABLE)}


    def fixed_files():
        m.need(m.file_sha(BASE) == BASE_SHA, 'REVIEWED_ONEOFF_CHANGED')
        m.need(m.file_sha(SCRIPT) == SCRIPT_SHA, 'REVIEWED_DIAGNOSTIC_CHANGED')
        m.need(m.file_sha(INPUT) == INPUT_SHA and m.file_sha(FAILED) == FAILED_SHA, 'ORIGINAL_FAILURE_CHANGED')
        m.need(m.file_sha(TLS_FAILED) == TLS_FAILED_SHA, 'PREVIOUS_DIAGNOSTIC_CHANGED')
        m.need(m.file_sha(PREVIOUS) == PREVIOUS_SHA, 'PREVIOUS_READBACK_CHANGED')
        previous = m.read_json(PREVIOUS)
        m.need(previous.get('status') == 'VERIFIED' and previous.get('containerExitCode') == 0
               and previous.get('mode') == MODE and previous.get('sourceSha') == SOURCE
               and previous.get('taskArn') == 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/cb33dedc2f3c495b9e20b001c2866cd1'
               and len(previous.get('ownerReceipts',[])) == 1, 'PREVIOUS_READBACK_SCOPE')
        previous_owner = previous['ownerReceipts'][0]
        m.need(previous_owner.get('status') == 'READBACK_COMPLETE' and previous_owner.get('readOnly') is True
               and previous_owner.get('mutations') == 0
               and previous_owner.get('captureRunId') == 'c6ffa5ad-dd9f-4912-bc31-a03231a9b903'
               and len(previous_owner.get('candidates',[])) == 1
               and previous_owner['candidates'][0].get('id') == '557b5b98-f591-50ce-83ea-2ca44d44567a'
               and previous_owner['candidates'][0].get('row_version') == '113340385', 'PREVIOUS_CANDIDATE_SCOPE')
        tls_failed = m.read_json(TLS_FAILED)
        m.need(tls_failed.get('status') == 'RECONCILIATION_REQUIRED' and tls_failed.get('containerExitCode') == 1
               and tls_failed.get('taskArn') == 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/687007f2d36d4a8da63e7e92de083eb7'
               and tls_failed.get('ownerReceipts') == [{'kind':'meri-case01-readonly-reconciliation','schemaVersion':1,'status':'READBACK_FAILED',
                 'stage':'CONNECT','code':'UNABLE_TO_GET_ISSUER_CERT_LOCALLY','readOnly':True,'mutations':0,'liveAcceptance':'NOT_RUN'}], 'PREVIOUS_DIAGNOSTIC_SCOPE')
        failed = m.read_json(FAILED)
        m.need(failed.get('status') == 'RECONCILIATION_REQUIRED' and failed.get('mode') == 'setup-execute'
               and failed.get('sourceSha') == SOURCE and failed.get('containerExitCode') == 1
               and failed.get('code') == 'OWNER_PROCESS_FAILED'
               and failed.get('taskArn') == 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/69867ce349464296a6c613aaa6b08960', 'ORIGINAL_FAILURE_SCOPE')

    def source_check(a, repo, source_sha):
        fixed_files()
        m.need(source_sha == SOURCE, 'DIAGNOSTIC_SOURCE_MISMATCH')
        return original_source_check(a, repo, source_sha)

    def input_binding(mode, path, expected_hash):
        fixed_files()
        m.need(mode == MODE and pathlib.Path(path).resolve() == INPUT and expected_hash == INPUT_SHA, 'FIXED_INPUT_ONLY')
        value = m.read_json(INPUT)
        m.sanitize(value)
        recipe = value.get('recipe') or {}
        ctx = recipe.get('ctx') or {}
        m.need(ctx.get('tenantId') == m.T1 and ctx.get('tenantSlug') == m.NAMESPACE + '-t1'
               and ctx.get('role') == 'standard_user', 'DIAGNOSTIC_ACTOR_SCOPE')
        text = m.canonical(value)
        m.need(0 < len(text.encode()) <= 6000, 'INPUT_BYTE_LIMIT')
        overrides = {'containerOverrides': [{'name': CONTAINER, 'command': [],
                      'environment': [{'name': VARIABLE, 'value': text}]}]}
        m.need(len(m.canonical(overrides).encode()) <= 8192, 'ECS_OVERRIDE_BYTE_LIMIT')
        return value, overrides

    def task_request(a, snap, proof, mode):
        fixed_files()
        m.need(mode == MODE and proof.get('sourceSha') == SOURCE, 'FIXED_DIAGNOSTIC_ONLY')
        request = original_task_request(a, snap, proof, mode)
        container = request['containerDefinitions'][0]
        m.need({entry['name'] for entry in container['secrets']} == m.DB_REFS, 'DATABASE_REFERENCES_ONLY')
        # Copy the actual qualified service settings. The base operator checks
        # their required values, but narrows/reconstructs its synthetic cohort;
        # this diagnostic must observe the deployed authorization environment.
        current_env = a.unique(snap['container'].get('environment'), 'value')
        source_names = {'DB_NAME','GIT_SHA','RELEASE_SHA','MERI_SYNTHETIC_FIXTURE_NAMESPACE','MEMORY_GOVERNANCE_TENANTS'} | set(m.FLAGS)
        m.need(source_names <= set(current_env), 'DIAGNOSTIC_ENVIRONMENT_MISSING')
        container['environment'] = [{'name': name,'value': current_env[name]} for name in sorted(source_names)] + [{'name':'TMPDIR','value':'/dev/shm'}]
        container['entryPoint'] = ['node', '--input-type=module', '--eval', SCRIPT.read_text(encoding='utf-8')]
        container['command'] = []
        return request

    def owner_receipts(messages, mode, require_success=True):
        m.need(mode == MODE, 'FIXED_DIAGNOSTIC_ONLY')
        entries = []
        common = {'kind','schemaVersion','status','readOnly','mutations','liveAcceptance'}
        success = common | {'transport','captureRunId','claim','actors','grants','walls','expectedCandidates','candidates','items','outbox','embeddings','guardAudit','currentPolicyDecision','outboxProjectionColumns'}
        row_keys = {
          'actors': {'id','role','status'},
          'grants': {'id','user_id','client_id','permissions','status','expires_at','unexpired','reason_present'},
          'walls': {'client_id','user_id'},
          'expectedCandidates': {'generation','logicalId','id'},
          'candidates': {'id','proposed_by','client_id','status','governed_status','committed_memory_id','committed_memory_item_id','row_version'},
          'items': {'id','status','governed_status','source_type','source_id','source_content_hash','source_version','row_version'},
          'outbox': {'id','memory_item_id','clio_memory_id','operation','status','attempts','hasError','errorSha256','recognizedErrorCode'},
          'embeddings': {'source_type','source_id','model','content_hash','row_count'},
        }
        for message in messages:
            for line in message.splitlines():
                if not line.startswith(PREFIX): continue
                m.need(len(line.encode()) <= 100000, 'RECONCILE_RECEIPT_SIZE')
                entry = json.loads(line[len(PREFIX):])
                m.sanitize(entry)
                m.need(isinstance(entry,dict) and entry.get('kind') == 'meri-case01-readonly-reconciliation'
                       and entry.get('schemaVersion') == 1 and entry.get('readOnly') is True
                       and entry.get('mutations') == 0 and entry.get('liveAcceptance') == 'NOT_RUN', 'RECONCILE_RECEIPT_SCOPE')
                if entry.get('status') == 'READBACK_COMPLETE':
                    m.need(set(entry) == success and entry.get('captureRunId') == 'c6ffa5ad-dd9f-4912-bc31-a03231a9b903', 'RECONCILE_RECEIPT_FIELDS')
                    m.need(entry.get('transport') == {'tlsVerified':True,'caBundleSha256':'b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77'}, 'TLS_RECEIPT_INVALID')
                    guard = entry.get('guardAudit')
                    guard_keys = {'kind','candidateId','rowVersion','identityValidated','predicateCount','mismatchFields','expectedPayloadSha256','actualPayloadSha256','expectedProvenanceSha256','actualProvenanceSha256','predicateMatch','canonicalGuardExecuted'}
                    m.need(isinstance(guard,dict) and set(guard)==guard_keys
                           and guard.get('kind')=='deployed_pending_candidate_predicate_comparison'
                           and guard.get('candidateId')=='557b5b98-f591-50ce-83ea-2ca44d44567a'
                           and guard.get('rowVersion')=='113340385' and guard.get('identityValidated') is True
                           and type(guard.get('predicateCount')) is int and guard['predicateCount']==len(PREDICATES)
                           and guard.get('canonicalGuardExecuted') is False, 'CANDIDATE_GUARD_FIELDS')
                    mismatches=guard.get('mismatchFields')
                    m.need(isinstance(mismatches,list) and all(isinstance(field,str) and field in PREDICATES for field in mismatches)
                           and mismatches==sorted(set(mismatches))
                           and guard.get('predicateMatch') is (len(mismatches)==0), 'CANDIDATE_GUARD_MISMATCHES')
                    for key in ('expectedPayloadSha256','actualPayloadSha256','expectedProvenanceSha256','actualProvenanceSha256'):
                        m.need(isinstance(guard[key],str) and bool(re.fullmatch('[a-f0-9]{64}',guard[key])), 'CANDIDATE_GUARD_HASH')
                    for field,expected_key,actual_key in [('payload_jsonb','expectedPayloadSha256','actualPayloadSha256'),('provenance_jsonb','expectedProvenanceSha256','actualProvenanceSha256')]:
                        m.need((field in mismatches)==(guard[expected_key]!=guard[actual_key]), 'CANDIDATE_GUARD_HASH_MISMATCH')
                    auth=entry.get('currentPolicyDecision')
                    m.need(isinstance(auth,dict) and type(auth.get('allowed')) is bool, 'AUTHORIZATION_RESULT')
                    decision_key='basis' if auth['allowed'] else 'reason'
                    m.need(set(auth)=={'owner','operation','allowed','emitDenialMetrics','capabilityIssued','governanceTenantBound',decision_key}
                           and auth.get('owner')=='MemoryAuthorizationService.evaluateInTx' and auth.get('operation')=='approve'
                           and auth.get('emitDenialMetrics') is False and auth.get('capabilityIssued') is False and auth.get('governanceTenantBound') is True
                           and auth[decision_key] in (AUTH_BASES if auth['allowed'] else AUTH_REASONS), 'AUTHORIZATION_FIELDS')
                    columns=entry.get('outboxProjectionColumns')
                    m.need(isinstance(columns,list) and len(columns)==2 and all(isinstance(column,dict) for column in columns)
                           and [column.get('name') for column in columns]==['expected_source_version','expected_content_hash'], 'OUTBOX_COLUMN_SCOPE')
                    for column in columns:
                        m.need(type(column.get('exists')) is bool, 'OUTBOX_COLUMN_EXISTS')
                        if not column['exists']:
                            m.need(set(column)=={'name','exists'}, 'OUTBOX_MISSING_COLUMN_FIELDS')
                            continue
                        known_types={'timestamp with time zone','character varying(64)','text'}
                        keys={'name','exists','type','nullable','defaultPresent','defaultSql','defaultSha256'}
                        if column.get('type')=='UNRECOGNIZED':
                            keys.add('typeSha256')
                            m.need(isinstance(column.get('typeSha256'),str) and bool(re.fullmatch('[a-f0-9]{64}',column['typeSha256'])), 'OUTBOX_TYPE_HASH')
                        else: m.need(column.get('type') in known_types, 'OUTBOX_COLUMN_TYPE')
                        m.need(set(column)==keys and type(column.get('nullable')) is bool and type(column.get('defaultPresent')) is bool, 'OUTBOX_COLUMN_FIELDS')
                        if column['defaultPresent']:
                            m.need(column.get('defaultSql')=='REDACTED' and isinstance(column.get('defaultSha256'),str)
                                   and bool(re.fullmatch('[a-f0-9]{64}',column['defaultSha256'])), 'OUTBOX_DEFAULT_REDACTION')
                        else: m.need(column.get('defaultSql') is None and column.get('defaultSha256') is None, 'OUTBOX_NULL_DEFAULT')
                    claim=entry.get('claim')
                    m.need(isinstance(claim,dict) and set(claim) == {'status','recipeSha256','locatorPresent','bindingPresent'}
                           and claim.get('recipeSha256') == '29cc20de9afb70ec31e009afd0b7c3226482f1372b05d2ccec7e86a835ec0142', 'RECONCILE_CLAIM_BINDING')
                    for key, keys in row_keys.items():
                        m.need(isinstance(entry.get(key),list) and all(isinstance(row,dict) and set(row)==keys for row in entry[key]), 'RECONCILE_ROW_FIELDS')
                else:
                    m.need(entry.get('status') == 'READBACK_FAILED' and set(entry) == common | {'stage','code'}, 'RECONCILE_FAILURE_FIELDS')
                entries.append(entry)
        m.need(len(entries) <= 1, 'RECONCILE_RECEIPT_COUNT')
        if require_success:
            m.need(len(entries) == 1 and entries[0]['status'] == 'READBACK_COMPLETE', 'RECONCILE_RECEIPT_INVALID')
        return entries

    def qualify(a, repo, aws, proof_file, proof_hash):
        fixed_files()
        return original_qualify(a, repo, aws, proof_file, proof_hash)

    m.fixed_files = fixed_files
    m.source_check, m.input_binding, m.task_request = source_check, input_binding, task_request
    m.owner_receipts, m.qualify = owner_receipts, qualify
    return m


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'run'])
    for name in ('repo', 'proof', 'proof-sha256', 'out'):
        parser.add_argument('--' + name, required=True)
    for name in ('plan', 'plan-sha256', 'confirm'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    try:
        m = load_operator()
        args.mode, args.input, args.input_sha256 = MODE, str(INPUT), INPUT_SHA
        if args.action == 'run':
            m.need(args.confirm == 'RUN_ONE_READONLY_CASE01_RECONCILIATION', 'CONFIRMATION_REQUIRED')
            args.confirm = 'RUN_ONE_REVIEWED_CASE01_TASK'
        a = m.adapter()
        helper, _ = a.load_helpers(args.repo)
        aws = a.Aws('default')
        result = m.prepare(a, helper, aws, args) if args.action == 'prepare' else m.run(a, helper, aws, args)
        print(json.dumps(result))
        return 0
    except Exception:
        print(json.dumps({'status': 'BLOCKED', 'code': 'FIXED_RECONCILIATION_REFUSED'}))
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
