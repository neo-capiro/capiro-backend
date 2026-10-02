"""Fixed first-approval recovery operator. Preparation/tests perform no AWS writes.

Reuses the immutable case01 one-off lifecycle. Only the exact original fixture
may be planned/recovered, once; unknown outcomes preserve all receipts/claims.
"""
import argparse, copy, hashlib, importlib.util, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent
BASE = ROOT / 'case01-oneoff.py'
BASE_SHA = '4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
ORIGINAL_INPUT = ROOT / 'setup-execute-input.json'
ORIGINAL_INPUT_SHA = '2abd45698d1ca98629e060178b702a21bfe0c7c56ec790258f6e1653aab5ab8c'
FAILED = ROOT / 'setup-execute-execution.json'
FAILED_SHA = '391f4e6afb7026847745c4503f10a520b6196309be54c37724fddd0f8d242b93'
READBACK = ROOT / 'case01-reconcile-v3-execution.json'
READBACK_SHA = 'ef091a69683a0f2229928f964da7cbb9a6863c3f72c43f1b709f6dc50436e7b0'
RUN = 'c6ffa5ad-dd9f-4912-bc31-a03231a9b903'
CANDIDATE = '557b5b98-f591-50ce-83ea-2ca44d44567a'
VERSION = '113340385'
PLAN_MODE, EXECUTE_MODE = 'setup-recovery-plan', 'setup-recovery-execute'
INPUTS = {PLAN_MODE: ROOT / 'case01-recovery-plan-input.json', EXECUTE_MODE: ROOT / 'case01-recovery-execute-input.json'}
TASK_PLANS = {mode: ROOT / ('case01-recovery-' + ('plan' if mode == PLAN_MODE else 'execute') + '-task-plan.json') for mode in INPUTS}
EXECUTIONS = {mode: ROOT / ('case01-recovery-' + ('plan' if mode == PLAN_MODE else 'execute') + '-execution.json') for mode in INPUTS}
SOURCE_HASHES = {
    'apps/api/scripts/meri-case01-setup.mjs': 'a60b740024569e8740ae16c0040de84b8882279cc59e09ee3c606a713145df55',
    'evals/meri/live-v1/fixture-provisioning/case01-execution-setup.mjs': 'e7d7ceadfe6c224ecff48e1a99d9ab10fa46e60e2fa37daef6d54212f5b7fb96',
}
PLAN_KEYS = set('kind schemaVersion recoveryMode recipeSha256 captureRunId originalClaimSha256 candidateId candidateRowVersion candidatePayloadSha256 previousManifestSha256 currentManifestSha256 tenantRowVersion priorSettingsSha256 liveAcceptance planSha256'.split())
STAGES = ['RECOVERY_ADMISSION', 'FIRST_CANONICAL_APPROVAL', 'PREVIOUS_SEED', 'PREVIOUS_RETIRE', 'CURRENT_SEED', 'BIND', 'LOCATOR', 'CONVERSATION', 'READBACK']
FAILURE_CLASSES = set('Error FixtureProvisioningError ForbiddenException BadRequestException NotFoundException ConflictException PrismaClientKnownRequestError PrismaClientUnknownRequestError PrismaClientInitializationError PrismaClientValidationError UnknownError'.split())
PRISMA_CODES = set('P1000 P1001 P1002 P1008 P1010 P1011 P1017 P2000 P2002 P2003 P2004 P2006 P2010 P2011 P2014 P2021 P2022 P2024 P2025 P2028 P2034'.split())
SQL_CODES = set('08001 08006 08P01 22001 22P02 23502 23503 23505 23514 25006 25P02 40001 40P01 42501 42703 42P01 57014 P0001'.split())


def load_operator(mode):
    if hashlib.sha256(BASE.read_bytes()).hexdigest() != BASE_SHA:
        raise RuntimeError('REVIEWED_ONEOFF_CHANGED')
    spec = importlib.util.spec_from_file_location('reviewed_case01_recovery_base', BASE)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    m.need(mode in INPUTS, 'RECOVERY_MODE_REQUIRED')
    original_source_check, original_task_request, original_qualify = m.source_check, m.task_request, m.qualify
    m.__file__ = __file__
    m.MODES = {PLAN_MODE: ('meri-case01-setup', 'recover-plan', 'MERI_CASE01_SETUP_INPUT'),
               EXECUTE_MODE: ('meri-case01-setup', 'recover-execute', 'MERI_CASE01_SETUP_INPUT')}

    def fixed_inputs():
        m.need(m.file_sha(BASE) == BASE_SHA, 'ORIGINAL_EVIDENCE_CHANGED')
        def pinned_json(path, expected):
            data = path.read_bytes()
            m.need(m.sha(data) == expected, 'ORIGINAL_EVIDENCE_CHANGED')
            def pairs(items):
                result = {}
                for key, value in items:
                    m.need(key not in result, 'DUPLICATE_JSON_KEY'); result[key] = value
                return result
            return json.loads(data.decode('utf-8-sig'), object_pairs_hook=pairs)
        original = pinned_json(ORIGINAL_INPUT, ORIGINAL_INPUT_SHA)
        failed, readback = pinned_json(FAILED, FAILED_SHA), pinned_json(READBACK, READBACK_SHA)
        m.need(failed.get('status') == 'RECONCILIATION_REQUIRED' and failed.get('containerExitCode') == 1 and failed.get('mode') == 'setup-execute'
               and failed.get('taskArn') == f'arn:aws:ecs:{m.REGION}:{m.ACCOUNT}:task/{m.CLUSTER}/69867ce349464296a6c613aaa6b08960', 'ORIGINAL_FAILURE_SCOPE')
        m.need(readback.get('status') == 'VERIFIED' and readback.get('containerExitCode') == 0 and len(readback.get('ownerReceipts', [])) == 1
               and readback.get('taskArn') == f'arn:aws:ecs:{m.REGION}:{m.ACCOUNT}:task/{m.CLUSTER}/9452a0ae070047a4a76a5328abc66126', 'READBACK_SCOPE')
        owner = readback['ownerReceipts'][0]; guard = owner.get('guardAudit', {})
        m.need(owner.get('captureRunId') == RUN and owner.get('readOnly') is True and owner.get('mutations') == 0
               and guard.get('candidateId') == CANDIDATE and guard.get('rowVersion') == VERSION
               and guard.get('predicateMatch') is True and guard.get('predicateCount') == 55 and guard.get('mismatchFields') == []
               and owner.get('currentPolicyDecision', {}).get('allowed') is True, 'READBACK_NOT_FIRST_APPROVAL_PENDING')
        recipe = original['recipe']
        m.need(recipe['captureRunId'] == RUN and recipe['ctx']['tenantId'] == m.T1
               and m.digest(recipe) == owner['claim']['recipeSha256'], 'ORIGINAL_RECIPE_CHANGED')
        original = {'kind': 'meri-case01-execution-setup', 'captureRunId': RUN,
                    'recipeSha256': m.digest(recipe), 'status': 'STARTED', 'liveAcceptance': 'NOT_RUN'}
        return {'recipe': recipe, 'expected': {'originalClaimSha256': m.digest(original), 'candidateRowVersion': VERSION}}

    def validate_owner_plan(value):
        base = fixed_inputs()
        m.need(isinstance(value, dict) and set(value) == PLAN_KEYS, 'OWNER_PLAN_FIELDS')
        body = dict(value); claimed = body.pop('planSha256')
        m.need(claimed == m.digest(body), 'OWNER_PLAN_HASH')
        m.need(value['kind'] == 'meri-case01-first-approval-recovery-plan' and value['schemaVersion'] == 1
               and value['recoveryMode'] == 'FIRST_APPROVAL_PENDING' and value['captureRunId'] == RUN
               and value['candidateId'] == CANDIDATE and value['candidateRowVersion'] == VERSION
               and value['recipeSha256'] == m.digest(base['recipe']) and value['originalClaimSha256'] == base['expected']['originalClaimSha256']
               and value['liveAcceptance'] == 'NOT_RUN', 'OWNER_PLAN_SCOPE')
        for key in ['candidatePayloadSha256', 'previousManifestSha256', 'currentManifestSha256', 'priorSettingsSha256']:
            m.need(isinstance(value[key], str) and re.fullmatch('[a-f0-9]{64}', value[key]), 'OWNER_PLAN_HASH_FIELD')
        m.need(isinstance(value['tenantRowVersion'], str) and re.fullmatch('[0-9]{1,15}', value['tenantRowVersion']), 'OWNER_PLAN_VERSION')
        return value

    def plan_execution(expected_hash=None):
        path = EXECUTIONS[PLAN_MODE]
        if expected_hash is not None: m.need(m.file_sha(path) == expected_hash, 'OWNER_PLAN_EXECUTION_CHANGED')
        receipt, task_plan = m.read_json(path), m.read_json(TASK_PLANS[PLAN_MODE])
        plan_body = dict(task_plan); plan_hash = plan_body.pop('planHash', None)
        m.need(plan_hash == m.digest(plan_body) and task_plan.get('operatorSha256') == m.file_sha(__file__), 'OWNER_TASK_PLAN_CHANGED')
        m.need(receipt.get('status') == 'VERIFIED' and receipt.get('mode') == PLAN_MODE and receipt.get('containerExitCode') == 0
               and receipt.get('planHash') == plan_hash and receipt.get('sourceSha') == task_plan.get('sourceSha')
               and receipt.get('operationId') == task_plan.get('operationId') and len(receipt.get('ownerReceipts', [])) == 1
               and task_plan.get('inputSha256') == m.file_sha(INPUTS[PLAN_MODE]), 'OWNER_PLAN_EXECUTION_SCOPE')
        owner = validate_owner_plan(receipt['ownerReceipts'][0])
        return receipt, task_plan, owner

    def source_check(a, repo, source_sha):
        fixed_inputs()
        operator_head = original_source_check(a, repo, source_sha)
        for path, expected in SOURCE_HASHES.items():
            m.need(m.sha(a.git(repo, 'show', source_sha + ':' + path)) == expected, 'RECOVERY_IMAGE_SOURCE_CHANGED')
        return operator_head

    def input_binding(selected_mode, path, expected_hash):
        base = fixed_inputs()
        m.need(selected_mode in INPUTS and pathlib.Path(path).resolve() == INPUTS[selected_mode]
               and m.file_sha(path) == expected_hash, 'FIXED_RECOVERY_INPUT_REQUIRED')
        value = m.read_json(path); m.sanitize(value)
        if selected_mode == PLAN_MODE:
            m.need(value == base, 'RECOVERY_PLAN_INPUT_CHANGED')
        else:
            m.need(set(value) == {'recipe', 'expected', 'expectedPlanSha256', 'ownerPlanExecutionSha256'}
                   and value['recipe'] == base['recipe'] and value['expected'] == base['expected'], 'RECOVERY_EXECUTE_INPUT_CHANGED')
            _, _, owner = plan_execution(value['ownerPlanExecutionSha256'])
            m.need(value['expectedPlanSha256'] == owner['planSha256'], 'RECOVERY_OWNER_PLAN_REBOUND')
        owner_input = {key: item for key, item in value.items() if key != 'ownerPlanExecutionSha256'}
        text = m.canonical(owner_input); m.need(len(text.encode()) <= 6000, 'INPUT_BYTE_LIMIT')
        verb, action, variable = m.MODES[selected_mode]
        overrides = {'containerOverrides': [{'name': m.CONTAINER,
            'command': [verb, action, '--input-env', variable, '--out', '/dev/shm/meri-case01-owner-receipt.jsonl'],
            'environment': [{'name': variable, 'value': text}]}]}
        m.need(len(m.canonical(overrides).encode()) <= 8192, 'ECS_OVERRIDE_BYTE_LIMIT')
        return value, overrides

    def task_request(a, snap, proof, selected_mode):
        result = original_task_request(a, snap, proof, selected_mode)
        if selected_mode == EXECUTE_MODE:
            api = snap['container']; env, refs = a.unique(api.get('environment'), 'value'), a.unique(api.get('secrets'), 'valueFrom')
            m.need('OPENAI_API_KEY' not in env, 'PLAINTEXT_PROVIDER_KEY_REFUSED')
            if 'OPENAI_API_KEY' in refs:
                result['containerDefinitions'][0]['secrets'].append({'name': 'OPENAI_API_KEY', 'valueFrom': refs['OPENAI_API_KEY']})
        return result

    def owner_receipts(messages, selected_mode, require_success=True):
        entries = []
        for message in messages:
            for line in message.splitlines():
                if not line.startswith(m.PREFIX['setup']): continue
                m.need(len(line.encode()) <= 200000, 'OWNER_RECEIPT_SIZE')
                entry = json.loads(line[len(m.PREFIX['setup']):]); m.sanitize(entry)
                if selected_mode == PLAN_MODE:
                    validate_owner_plan(entry)
                else:
                    m.need(isinstance(entry, dict), 'OWNER_JOURNAL_FIELDS')
                    if entry.get('stage') == 'COMPLETE':
                        m.need(set(entry) == {'stage', 'phase', 'receipt'} and entry['phase'] == 'VERIFIED', 'OWNER_COMPLETE_FIELDS')
                        result, base = entry['receipt'], fixed_inputs()
                        result_keys = set('kind schemaVersion status captureRunId conversationId ctx clientId binding bindingSha256 locatorSha256 sourceMap currentVerifySha256 seedReceiptId resetReceiptId projectionStatus liveAcceptance synthesisSubmissionCount'.split())
                        m.need(isinstance(result, dict) and set(result) == result_keys, 'OWNER_COMPLETE_FIELDS')
                        m.need(result.get('kind') == 'meri-case01-execution-setup-receipt' and result.get('schemaVersion') == 1 and result.get('status') == 'SETUP_COMPLETE'
                               and result.get('captureRunId') == RUN and result.get('ctx') == base['recipe']['ctx']
                               and result.get('clientId') == base['recipe']['clients']['ASTER']['physicalId']
                               and result.get('liveAcceptance') == 'NOT_RUN' and result.get('synthesisSubmissionCount') == 0
                               and result.get('projectionStatus') == 'CANONICAL_OUTBOX_RECORDED_NOT_QUALIFIED'
                               and set(result.get('sourceMap', {})) == {'MA1-v2'}, 'OWNER_COMPLETE_SCOPE')
                        binding, source = result['binding'], result['sourceMap']['MA1-v2']
                        m.need(isinstance(binding, dict) and set(binding) == set('caseId captureRunId fixtureVersion physicalMapSha256 seedReceiptId resetReceiptId fixtureNamespace actorUserId clientId currentVerifySha256'.split()), 'OWNER_BINDING_FIELDS')
                        m.need(binding['caseId'] == '01' and binding['captureRunId'] == RUN
                               and binding['fixtureNamespace'] == m.NAMESPACE and binding['actorUserId'] == result['ctx']['userId']
                               and binding['clientId'] == result['clientId'] and binding['physicalMapSha256'] == m.digest(result['sourceMap'])
                               and result['bindingSha256'] == m.digest(binding)
                               and all(binding[key] == result[key] for key in ['seedReceiptId','resetReceiptId','currentVerifySha256']), 'OWNER_BINDING_JOIN')
                        for key in ['bindingSha256','locatorSha256','currentVerifySha256']:
                            m.need(isinstance(result[key], str) and re.fullmatch('[a-f0-9]{64}', result[key]), 'OWNER_COMPLETE_HASH')
                        m.need(all(isinstance(value, str) and 0 < len(value) <= 256 for value in [binding['fixtureVersion'], result['seedReceiptId'], result['resetReceiptId']]), 'OWNER_RECEIPT_IDENTIFIER')
                        m.need(isinstance(source, dict) and set(source) == set('frozenFixtureId physicalId tenantPhysicalId clientPhysicalId kind version'.split())
                               and source['frozenFixtureId'] == 'MA1-v2' and source['tenantPhysicalId'] == m.T1
                               and source['clientPhysicalId'] == result['clientId'] and source['kind'] == 'memory', 'OWNER_SOURCE_SCOPE')
                        for value in [result['conversationId'], source['physicalId']]:
                            m.need(isinstance(value, str) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value), 'OWNER_PHYSICAL_ID')
                    else:
                        m.need(entry.get('stage') in STAGES and entry.get('captureRunId') == RUN
                               and entry.get('phase') in {'INTENT', 'VERIFIED', 'RECONCILIATION_REQUIRED'}, 'OWNER_JOURNAL_SCOPE')
                        extra = 'claimSha256' if entry['stage'] == 'RECOVERY_ADMISSION' else 'resultSha256'
                        keys = {'stage', 'phase', 'captureRunId'} | ({extra} if entry['phase'] == 'VERIFIED' else {'failure'} if entry['phase'] == 'RECONCILIATION_REQUIRED' else set())
                        m.need(set(entry) == keys, 'OWNER_JOURNAL_FIELDS')
                        if entry['phase'] == 'VERIFIED': m.need(re.fullmatch('[a-f0-9]{64}', entry[extra]), 'OWNER_RESULT_HASH')
                        if entry['phase'] == 'RECONCILIATION_REQUIRED':
                            failure = entry['failure']
                            m.need(isinstance(failure, dict) and set(failure) == {'stage','errorClass','prismaCode','sqlState'}
                                   and failure['stage'] == entry['stage'] and failure['errorClass'] in FAILURE_CLASSES
                                   and failure['prismaCode'] in PRISMA_CODES | {None} and failure['sqlState'] in SQL_CODES | {None}, 'OWNER_FAILURE_FIELDS')
                entries.append(entry)
        m.need(len(entries) <= 24, 'OWNER_RECEIPT_COUNT')
        if require_success:
            if selected_mode == PLAN_MODE: m.need(len(entries) == 1, 'OWNER_PLAN_MISSING')
            else:
                expected = [(stage, phase) for stage in STAGES for phase in ['INTENT', 'VERIFIED']] + [('COMPLETE', 'VERIFIED')]
                m.need([(entry.get('stage'), entry.get('phase')) for entry in entries] == expected, 'OWNER_RECOVERY_NOT_COMPLETE')
        return entries

    def qualify(a, repo, aws, proof_file, proof_hash):
        proof = original_qualify(a, repo, aws, proof_file, proof_hash)
        if mode == EXECUTE_MODE:
            value, _ = input_binding(mode, INPUTS[mode], m.file_sha(INPUTS[mode]))
            prior, task_plan, _ = plan_execution(value['ownerPlanExecutionSha256'])
            m.need(prior['sourceSha'] == proof['sourceSha'] and task_plan['imageDigest'] == proof['imageDigest'], 'OWNER_PLAN_IMAGE_DRIFT')
            _, overrides = input_binding(PLAN_MODE, INPUTS[PLAN_MODE], m.file_sha(INPUTS[PLAN_MODE]))
            tasks = aws.tasks([prior['taskArn']]); m.need(len(tasks) == 1, 'OWNER_PLAN_TASK_MISSING')
            task = tasks[0]; container = m.task_identity(task, prior['taskArn'], prior['taskDefinition'], overrides, proof['imageDigest'])
            m.need(task.get('lastStatus') == 'STOPPED' and container.get('lastStatus') == 'STOPPED'
                   and container.get('exitCode') == 0 and container.get('imageDigest') == proof['imageDigest'], 'OWNER_PLAN_TASK_NOT_SUCCESSFUL')
            helper, _ = a.load_helpers(repo)
            request = helper.task_registration_request(aws.definition(prior['taskDefinition']))
            m.need(m.digest(m.definition_projection(a, request)) == task_plan['oneOffDefinitionHash'], 'OWNER_PLAN_DEFINITION_CHANGED')
            opts = request['containerDefinitions'][0]['logConfiguration']['options']
            stream = opts['awslogs-stream-prefix'] + '/' + m.CONTAINER + '/' + prior['taskArn'].rsplit('/', 1)[1]
            m.need(owner_receipts(aws.logs(opts['awslogs-group'], stream), PLAN_MODE) == prior['ownerReceipts'], 'OWNER_PLAN_LOGS_CHANGED')
        return proof

    m.fixed_inputs, m.validate_owner_plan, m.plan_execution = fixed_inputs, validate_owner_plan, plan_execution
    m.source_check, m.input_binding, m.task_request = source_check, input_binding, task_request
    m.owner_receipts, m.qualify = owner_receipts, qualify
    return m


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['materialize-plan-input', 'materialize-execute-input', 'prepare', 'run'])
    parser.add_argument('--mode', choices=list(INPUTS), required=True)
    for name in ['repo','proof','proof-sha256','input','input-sha256','out','plan','plan-sha256','confirm','owner-plan-execution-sha256']:
        parser.add_argument('--' + name)
    parser.add_argument('--profile', default='default')
    args = parser.parse_args(); m = load_operator(args.mode)
    try:
        if args.action.startswith('materialize-'):
            value = m.fixed_inputs()
            if args.action == 'materialize-plan-input': m.need(args.mode == PLAN_MODE, 'PLAN_INPUT_MODE')
            else:
                m.need(args.mode == EXECUTE_MODE and args.owner_plan_execution_sha256, 'OWNER_PLAN_HASH_REQUIRED')
                _, _, owner = m.plan_execution(args.owner_plan_execution_sha256)
                value.update(expectedPlanSha256=owner['planSha256'], ownerPlanExecutionSha256=args.owner_plan_execution_sha256)
            m.create(INPUTS[args.mode], value)
            print(json.dumps({'status': 'INPUT_PREPARED', 'path': str(INPUTS[args.mode]), 'sha256': m.file_sha(INPUTS[args.mode]), 'awsCalls': 0})); return 0
        m.need(all(getattr(args, name) for name in ['repo','proof','proof_sha256','input','input_sha256','out']), 'ARGUMENTS_REQUIRED')
        expected_out = TASK_PLANS[args.mode] if args.action == 'prepare' else EXECUTIONS[args.mode]
        m.need(pathlib.Path(args.out).resolve() == expected_out, 'FIXED_OUTPUT_REQUIRED')
        if args.action == 'run': m.need(args.plan and pathlib.Path(args.plan).resolve() == TASK_PLANS[args.mode], 'FIXED_TASK_PLAN_REQUIRED')
        a = m.adapter(); helper, _ = a.load_helpers(args.repo); aws = a.Aws(args.profile)
        result = m.prepare(a, helper, aws, args) if args.action == 'prepare' else m.run(a, helper, aws, args)
        print(json.dumps(result)); return 0
    except Exception as error:
        print(json.dumps({'status': 'BLOCKED', 'code': str(error) if isinstance(error, m.Refusal) else 'RECOVERY_OPERATOR_REFUSED'})); return 1

if __name__ == '__main__': raise SystemExit(main())
