"""One fixed, read-only canonical reconciliation task for the failed case01 setup.

Reuses the exact reviewed one-off lifecycle. No generic command/script/input,
provider credential, registration retry, setup mutation or service update exists.
"""
import argparse, copy, importlib.util, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent
BASE = ROOT / 'case01-oneoff.py'
BASE_SHA = '4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
SCRIPT = ROOT / 'case01-reconcile-readonly.mjs'
SCRIPT_SHA = 'fbfa5799b1cee3b5619af545ef3d115dfc1a19b9498374c7092e5ba3f39aded3'
INPUT = ROOT / 'setup-execute-input.json'
INPUT_SHA = '2abd45698d1ca98629e060178b702a21bfe0c7c56ec790258f6e1653aab5ab8c'
FAILED = ROOT / 'setup-execute-execution.json'
FAILED_SHA = '391f4e6afb7026847745c4503f10a520b6196309be54c37724fddd0f8d242b93'
SOURCE = 'c11c83fe1759183254b24d11a9087ccc89595a73'
MODE = 'reconcile-read'
FAMILY = 'capiro-dev-meri-case01-reconcile'
CONTAINER = 'meri-case01-reconcile'
VARIABLE = 'MERI_CASE01_RECONCILE_INPUT'
PREFIX = 'MERI_CASE01_RECONCILE_RECEIPT '


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
        container['environment'] = [entry for entry in container['environment']
                                    if entry['name'] in {'DB_NAME', 'GIT_SHA', 'RELEASE_SHA', 'TMPDIR'}]
        container['entryPoint'] = ['node', '--input-type=module', '--eval', SCRIPT.read_text(encoding='utf-8')]
        container['command'] = []
        return request

    def owner_receipts(messages, mode, require_success=True):
        m.need(mode == MODE, 'FIXED_DIAGNOSTIC_ONLY')
        entries = []
        common = {'kind','schemaVersion','status','readOnly','mutations','liveAcceptance'}
        success = common | {'captureRunId','claim','actors','grants','walls','expectedCandidates','candidates','items','outbox','embeddings'}
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
