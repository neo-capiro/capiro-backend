"""Fixed case01 ECS operator. Import/offline tests never call AWS.

prepare is AWS read-only. run registers/runs ONE reviewed task; no retry/resume.
Timeout/uncertain acknowledgement preserves durable evidence, never success.
"""
import argparse, copy, hashlib, importlib.util, json, os, pathlib, re, time, uuid

ROOT = pathlib.Path(__file__).resolve().parent
ADAPTER = ROOT.parent / 'oct02-release-path' / 'synthetic-canary-codebuild.py'
ADAPTER_SHA = '02098e0d9209f7313a66c4e73eb0689332af2edd7ba2a2ecf6e6daa58b0671f6'
ACCOUNT, REGION, CLUSTER, SERVICE = '967807252336', 'us-east-1', 'capiro-dev', 'capiro-dev-api'
CALLER = f'arn:aws:iam::{ACCOUNT}:user/hermes-cli'
FAMILY, CONTAINER = 'capiro-dev-meri-case01-operator', 'meri-case01-operator'
NAMESPACE = 'meri-foundation-20260928'
T1, T2 = 'f2d6cf8f-057c-479a-8110-62fe5086d43f', '52e91176-08f0-4d89-9633-bc212f5bdbbf'
DB_REFS = {'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD'}
FLAGS = ('MEMORY_GOVERNANCE_LIFECYCLE', 'MEMORY_GOVERNANCE_CENTER', 'MEMORY_GOVERNANCE_ENFORCE', 'MEMORY_CLIENT_REVIEW')
MODES = {
    'setup-plan': ('meri-case01-setup', 'plan', 'MERI_CASE01_SETUP_INPUT'),
    'setup-execute': ('meri-case01-setup', 'execute', 'MERI_CASE01_SETUP_INPUT'),
    'budget-plan': ('meri-capture-provider-budget', 'plan', 'MERI_CAPTURE_PROVIDER_BUDGET_INPUT'),
    'budget-install': ('meri-capture-provider-budget', 'install', 'MERI_CAPTURE_PROVIDER_BUDGET_INPUT'),
}
PREFIX = {'setup': 'MERI_CASE01_SETUP_RECEIPT ', 'budget': 'MERI_CAPTURE_PROVIDER_BUDGET_RECEIPT '}

class Refusal(Exception): pass
def need(ok, code):
    if not ok: raise Refusal(code)
def sha(data): return hashlib.sha256(data).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def digest(value): return sha(canonical(value).encode())
def file_sha(path): return sha(pathlib.Path(path).read_bytes())
def read_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'DUPLICATE_JSON_KEY'); result[key] = value
        return result
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'), object_pairs_hook=pairs)
def sanitize(value, depth=0):
    need(depth <= 20, 'RECEIPT_DEPTH')
    if isinstance(value, dict):
        for key, item in value.items():
            need(isinstance(key, str) and not re.search(r'password|secret|credential|authorization|cookie|database.?url|api.?key|session|raw|contentText|body|email', key, re.I), 'SENSITIVE_OUTPUT_KEY')
            sanitize(item, depth + 1)
    elif isinstance(value, list):
        need(len(value) <= 1000, 'RECEIPT_ARRAY'); [sanitize(item, depth + 1) for item in value]
    elif isinstance(value, str):
        need(len(value) <= 2000 and not re.search(r'postgres(?:ql)?://|Bearer\s|-----BEGIN|\bsk-[A-Za-z0-9]', value, re.I), 'SENSITIVE_OUTPUT_VALUE')
    else: need(value is None or isinstance(value, (int, float, bool)), 'RECEIPT_VALUE')
    return value
def output_path(path):
    target = pathlib.Path(path).resolve()
    need(target.parent == ROOT and target.suffix == '.json', 'OUTPUT_OUTSIDE_TASK_ROOT')
    return target
def create(path, value):
    with output_path(path).open('x', encoding='utf-8') as handle:
        json.dump(sanitize(value), handle, indent=2); handle.flush(); os.fsync(handle.fileno())
def save(path, value):
    target = output_path(path); temp = target.with_name(target.name + '.writing')
    with temp.open('x', encoding='utf-8') as handle:
        json.dump(sanitize(value), handle, indent=2); handle.flush(); os.fsync(handle.fileno())
    os.replace(temp, target)
def adapter():
    need(file_sha(ADAPTER) == ADAPTER_SHA, 'REVIEWED_ADAPTER_CHANGED')
    spec = importlib.util.spec_from_file_location('case01_reviewed_canary', ADAPTER)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
def source_check(a, repo, source_sha):
    need(isinstance(source_sha, str) and re.fullmatch(r'[a-f0-9]{40}', source_sha), 'INVALID_SOURCE_SHA')
    head = a.git(repo, 'rev-parse', 'HEAD').decode().strip()
    need(head == a.git(repo, 'rev-parse', 'origin/main').decode().strip(), 'EXACT_MAIN_SOURCE_REQUIRED')
    need(not a.git(repo, 'status', '--porcelain=v1', '--untracked-files=all').strip(), 'DIRTY_OPERATOR_SOURCE')
    need(a.git(repo, 'remote', 'get-url', 'origin').decode().strip().removesuffix('.git') == 'https://github.com/neo-capiro/capirov2', 'NONCANONICAL_REPOSITORY')
    if head != source_sha:
        need(a.git(repo, 'merge-base', source_sha, head).decode().strip() == source_sha, 'IMAGE_SOURCE_NOT_MAIN_ANCESTOR')
        paths = a.git(repo, 'diff', '--name-only', '--no-renames', '-z', source_sha, head).decode().split('\0')
        need(all(path.startswith('docs/') for path in paths if path), 'NON_DOCUMENTATION_SOURCE_DRIFT')
    script = a.git(repo, 'show', source_sha + ':apps/api/scripts/entrypoint.sh').decode()
    for verb in ('meri-case01-setup', 'meri-capture-provider-budget'):
        need(re.search(re.escape(verb) + r'\)\s+shift\s+compose_database_url\s+exec node scripts/' + re.escape(verb) + r'\.mjs', script), 'FIXED_ENTRYPOINT_VERB_REQUIRED')
    return head

def input_binding(mode, path, expected_hash):
    need(mode in MODES and file_sha(path) == expected_hash, 'INPUT_HASH_OR_MODE')
    value = read_json(path); sanitize(value)
    text = canonical(value)
    need(0 < len(text.encode()) <= 6000, 'INPUT_BYTE_LIMIT')
    scope = value.get('recipe') if mode.startswith('setup-') else value
    need(isinstance(scope, dict), 'INPUT_SCOPE')
    ctx = scope.get('ctx') or {}
    need(ctx.get('tenantId') == T1 and ctx.get('tenantSlug') == NAMESPACE + '-t1' and ctx.get('role') == 'standard_user', 'INPUT_ACTOR_SCOPE')
    need(re.fullmatch(r'[a-f0-9-]{36}', ctx.get('userId', '')), 'INPUT_ACTOR_ID')
    if mode.startswith('budget-'):
        need(value.get('target') == CLUSTER and value.get('fixtureNamespace') == NAMESPACE, 'INPUT_TARGET')
    if mode == 'setup-execute': need(re.fullmatch(r'[a-f0-9]{64}', value.get('expectedPlanSha256', '')), 'SETUP_PLAN_REQUIRED')
    verb, action, variable = MODES[mode]
    command = [verb, action, '--input-env', variable, '--out', '/dev/shm/meri-case01-owner-receipt.jsonl']
    overrides = {'containerOverrides': [{'name': CONTAINER, 'command': command, 'environment': [{'name': variable, 'value': text}]}]}
    need(len(canonical(overrides).encode()) <= 8192, 'ECS_OVERRIDE_BYTE_LIMIT')
    return value, overrides

def snapshot(a, helper, aws, proof):
    service = aws.service(SERVICE)
    helper.assert_service_shape(service, service['taskDefinition'])
    need(len(service.get('deployments', [])) == 1 and a.primary_state(service).get('rolloutState') == 'COMPLETED', 'SERVICE_NOT_STEADY')
    response = aws.definition(service['taskDefinition']); definition = response['taskDefinition']
    tasks = aws.tasks(aws.task_arns(serviceName=SERVICE, desiredStatus='RUNNING'))
    need(len(tasks) == service['desiredCount'], 'SERVICE_TASK_COUNT')
    name = helper.find_target_container(definition, tasks, proof['imageDigest'])
    container = next(item for item in definition['containerDefinitions'] if item['name'] == name)
    need(container.get('image') == proof['image'], 'SERVICE_IMAGE_NOT_PINNED')
    helper.relevant_source_label(container, proof['sourceSha'])
    for task in tasks:
        need(task.get('taskDefinitionArn') == service['taskDefinition'] and task.get('clusterArn') == service['clusterArn'] and task.get('lastStatus') == 'RUNNING' and task.get('desiredStatus') == 'RUNNING', 'SERVICE_TASK_DRIFT')
    a.check_targets(aws, {'tasks': tasks, 'service': service, 'containerName': name})
    request = helper.task_registration_request(response)
    safe = {'taskDefinition': service['taskDefinition'], 'taskDefinitionHash': digest(request), 'serviceConfigHash': digest(a.service_config(service)), 'primaryDeploymentId': a.primary_state(service)['id'], 'runningTaskArns': sorted(task['taskArn'] for task in tasks)}
    return {'service': service, 'definition': request, 'container': container, 'safe': safe}

def task_request(a, snap, proof, mode):
    original, api = snap['definition'], snap['container']
    fields = ('taskRoleArn','executionRoleArn','networkMode','requiresCompatibilities','cpu','memory','runtimePlatform')
    need(all(key in original for key in fields), 'API_RUNTIME_FIELDS_MISSING')
    need(original['networkMode'] == 'awsvpc' and original['requiresCompatibilities'] == ['FARGATE'] and original['runtimePlatform'].get('cpuArchitecture') == 'ARM64', 'API_PLATFORM_MISMATCH')
    env, refs = a.unique(api.get('environment'), 'value'), a.unique(api.get('secrets'), 'valueFrom')
    need(not api.get('environmentFiles') and not (set(env) & set(refs)), 'OPAQUE_ENVIRONMENT')
    need(DB_REFS <= set(refs) and not (DB_REFS & set(env)) and env.get('DB_NAME') and 'DB_NAME' not in refs, 'DATABASE_SOURCE_MISMATCH')
    need(env.get('GIT_SHA') == env.get('RELEASE_SHA') == proof['sourceSha'], 'SOURCE_ENV_MISMATCH')
    need(all(env.get(key) == 'enforce' and key not in refs for key in FLAGS), 'GOVERNANCE_NOT_ENABLED')
    need(env.get('MERI_SYNTHETIC_FIXTURE_NAMESPACE') == NAMESPACE, 'NAMESPACE_NOT_ENABLED')
    cohort = env.get('MEMORY_GOVERNANCE_TENANTS', '').split(',')
    need(T1 in cohort and T2 in cohort and len(cohort) == len(set(cohort)) and all(re.fullmatch(r'[a-f0-9-]{36}', item) for item in cohort), 'SYNTHETIC_COHORT_NOT_ENABLED')
    allowed_env = ['DB_NAME', 'GIT_SHA', 'RELEASE_SHA', 'AWS_REGION_DEFAULT', 'EMBEDDINGS_MODEL', 'EMBEDDING_MODEL_VERSION']
    need(not (set(allowed_env) & set(refs)), 'MODEL_OR_ENV_SECRET_AMBIGUOUS')
    selected = {key: env[key] for key in allowed_env if key in env}
    selected.update({key: 'enforce' for key in FLAGS})
    selected.update(MEMORY_GOVERNANCE_TENANTS=T1+','+T2, MERI_SYNTHETIC_FIXTURE_NAMESPACE=NAMESPACE, TMPDIR='/dev/shm')
    names = set(DB_REFS)
    if mode == 'setup-execute':
        need('OPENAI_API_KEY' not in env, 'PLAINTEXT_PROVIDER_KEY_REFUSED')
        if 'OPENAI_API_KEY' in refs: names.add('OPENAI_API_KEY')
    logs = copy.deepcopy(api.get('logConfiguration'))
    need(logs and logs.get('logDriver') == 'awslogs', 'AWSLOGS_REQUIRED')
    opts = logs.get('options') or {}
    need(opts.get('awslogs-region') == REGION and opts.get('awslogs-group') and opts.get('awslogs-stream-prefix'), 'AWSLOGS_BINDING')
    result = {key: copy.deepcopy(original[key]) for key in fields}
    result.update(family=FAMILY, containerDefinitions=[{'name': CONTAINER, 'image': proof['image'], 'essential': True,
      'command': [MODES[mode][0], MODES[mode][1]], 'environment': [{'name': key, 'value': value} for key,value in sorted(selected.items())],
      'secrets': [{'name': key, 'valueFrom': refs[key]} for key in sorted(names)], 'logConfiguration': logs,
      'dockerLabels': {'org.opencontainers.image.revision': proof['sourceSha'], 'org.opencontainers.image.source': a.REPOSITORY}}])
    return result

def qualify(a, repo, aws, proof_file, proof_hash):
    need(file_sha(proof_file) == proof_hash, 'PROOF_HASH_MISMATCH')
    expected = read_json(proof_file); operator_head = source_check(a, repo, expected.get('sourceSha'))
    aws.identity(CALLER)
    proof = a.qualify_build(aws, repo, 'api', expected)
    build = aws.call('codebuild','batch_get_builds',ids=[proof['buildId']])['builds'][0]
    log = build['logs']; lines = [line.strip() for message in aws.logs(log['groupName'],log['streamName']) for line in message.splitlines()]
    need('OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS' in lines, 'CASE01_IMAGE_IMPORT_NOT_QUALIFIED')
    return dict(proof, operatorHead=operator_head)

def definition_projection(a, request):
    # Witnessed ECS normalization: uniquely named environment entries are reordered.
    # Preserve all fields/values and every other list, including secrets and commands.
    value = a.diagnostic_projection(request)
    for container in value.get('containerDefinitions', []):
        if 'environment' not in container:
            continue
        entries = container['environment']
        need(isinstance(entries, list), 'ENVIRONMENT_INVALID')
        names = set()
        for entry in entries:
            need(isinstance(entry, dict) and isinstance(entry.get('name'), str)
                 and bool(entry['name']) and entry['name'] not in names
                 and isinstance(entry.get('value'), str), 'ENVIRONMENT_INVALID')
            names.add(entry['name'])
        entries.sort(key=lambda entry: entry['name'])
    return value

def prepare(a, helper, aws, args):
    proof = qualify(a,args.repo,aws,args.proof,args.proof_sha256)
    _, overrides = input_binding(args.mode,args.input,args.input_sha256)
    snap = snapshot(a,helper,aws,proof); request = task_request(a,snap,proof,args.mode)
    body = {'schemaVersion':1,'mode':args.mode,'operationId':str(uuid.uuid4()),'createdAt':int(time.time()),'expiresAt':int(time.time())+1800,
      'sourceSha':proof['sourceSha'],'operatorHead':proof['operatorHead'],'imageDigest':proof['imageDigest'],'image':proof['image'],'inputSha256':args.input_sha256,
      'proofSha256':args.proof_sha256,'operatorSha256':file_sha(__file__),'adapterSha256':ADAPTER_SHA,'caller':CALLER,
      'baseline':snap['safe'],'oneOffDefinitionHash':digest(definition_projection(a, request)), 'overridesHash':digest(overrides),
      'networkHash':digest(snap['service']['networkConfiguration']), 'waitSeconds':900, 'liveAcceptance':'NOT_RUN'}
    body['planHash'] = digest(body); create(args.out,body); return {'status':'PREPARED','planHash':body['planHash']}

def normalize_overrides(overrides):
    value = copy.deepcopy(overrides)
    if value.get('inferenceAcceleratorOverrides') == []: value.pop('inferenceAcceleratorOverrides')
    for container in value.get('containerOverrides',[]):
        for key in ('environmentFiles','resourceRequirements'):
            if container.get(key) == []: container.pop(key)
    return value

def task_identity(task, arn, definition_arn, expected_overrides, digest_value):
    need(task.get('taskArn') == arn and task.get('clusterArn') == f'arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/{CLUSTER}' and task.get('taskDefinitionArn') == definition_arn, 'TASK_IDENTITY_DRIFT')
    need(normalize_overrides(task.get('overrides',{})) == expected_overrides, 'TASK_OVERRIDE_DRIFT')
    containers = task.get('containers') or []
    need(len(containers) == 1 and containers[0].get('name') == CONTAINER, 'TASK_CONTAINER_DRIFT')
    if containers[0].get('imageDigest'): need(containers[0]['imageDigest'] == digest_value, 'TASK_DIGEST_DRIFT')
    return containers[0]

def owner_receipts(messages, mode, require_success=True):
    prefix = PREFIX[mode.split('-')[0]]; entries = []
    for message in messages:
        for line in message.splitlines():
            if line.startswith(prefix):
                need(len(line.encode()) <= 200000, 'OWNER_RECEIPT_SIZE')
                entry = json.loads(line[len(prefix):]); sanitize(entry); entries.append(entry)
    need(len(entries) <= 40, 'OWNER_RECEIPT_COUNT')
    if not require_success: return entries
    need(bool(entries), 'OWNER_RECEIPT_COUNT')
    if mode == 'setup-plan': need(len(entries)==1 and entries[0].get('kind')=='meri-case01-execution-setup-plan', 'OWNER_PLAN_MISSING')
    elif mode == 'setup-execute': need(entries[-1].get('stage')=='COMPLETE' and entries[-1].get('phase')=='VERIFIED' and entries[-1].get('receipt',{}).get('status')=='SETUP_COMPLETE', 'OWNER_SETUP_NOT_COMPLETE')
    else: need(len(entries)==1 and entries[0].get('status')=={'budget-plan':'READY_FOR_RATE_QUALIFICATION','budget-install':'PROVIDER_QUALIFICATION_INSTALLED'}[mode], 'OWNER_BUDGET_RESULT')
    return entries

def run(a, helper, aws, args):
    plan = read_json(args.plan); expected = dict(plan); claimed_hash = expected.pop('planHash',None)
    need(claimed_hash == args.plan_sha256 == digest(expected), 'PLAN_HASH_MISMATCH')
    need(plan.get('operatorSha256') == file_sha(__file__) and plan.get('adapterSha256') == ADAPTER_SHA and plan.get('caller') == CALLER, 'OPERATOR_REVIEW_CHANGED')
    need(plan.get('mode')==args.mode and plan.get('inputSha256')==args.input_sha256 and plan.get('proofSha256')==args.proof_sha256, 'RUN_SCOPE_MISMATCH')
    need(plan.get('createdAt',0) <= time.time() <= plan.get('expiresAt',0) and plan.get('waitSeconds')==900, 'PLAN_EXPIRED')
    need(args.confirm == 'RUN_ONE_REVIEWED_CASE01_TASK', 'CONFIRMATION_REQUIRED')
    need(str(uuid.UUID(plan['operationId'])) == plan['operationId'], 'OPERATION_ID')
    lock = ROOT / ('case01-'+plan['operationId']+'.json')
    create(lock,{'status':'CLAIMED','planHash':claimed_hash,'mode':args.mode})
    journal = {'schemaVersion':1,'status':'CLAIMED','planHash':claimed_hash,'mode':args.mode,'operationId':plan['operationId'],'sourceSha':plan['sourceSha'],'operatorHead':plan['operatorHead'],'liveAcceptance':'NOT_RUN'}
    create(args.out,journal)
    try:
        proof = qualify(a,args.repo,aws,args.proof,args.proof_sha256)
        need(proof['operatorHead']==plan['operatorHead'] and proof['sourceSha']==plan['sourceSha'], 'OPERATOR_MAIN_DRIFT')
        _, overrides = input_binding(args.mode,args.input,args.input_sha256)
        snap = snapshot(a,helper,aws,proof); request = task_request(a,snap,proof,args.mode)
        need(snap['safe']==plan['baseline'] and digest(definition_projection(a, request))==plan['oneOffDefinitionHash'] and digest(overrides)==plan['overridesHash'] and digest(snap['service']['networkConfiguration'])==plan['networkHash'], 'BASELINE_OR_INPUT_DRIFT')
        journal['status']='REGISTER_INTENT'; save(args.out,journal)
        need(source_check(a,args.repo,proof['sourceSha'])==plan['operatorHead'], 'OPERATOR_MAIN_DRIFT'); aws.identity(CALLER)
        response = aws.call('ecs','register_task_definition',**a.registration_args(request))
        arn = response.get('taskDefinition',{}).get('taskDefinitionArn','')
        need(re.fullmatch(f'arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/{FAMILY}:[0-9]+',arn), 'REGISTER_ACK_UNKNOWN')
        journal.update(status='REGISTERED',taskDefinition=arn); save(args.out,journal)
        observed = helper.task_registration_request(aws.definition(arn))
        need(digest(definition_projection(a, observed))==plan['oneOffDefinitionHash'], 'REGISTERED_DEFINITION_DRIFT')
        need(snapshot(a,helper,aws,proof)['safe']==plan['baseline'], 'FINAL_SERVICE_DRIFT')
        need(source_check(a,args.repo,proof['sourceSha'])==plan['operatorHead'], 'OPERATOR_MAIN_DRIFT'); aws.identity(CALLER)
        started = 'meri-c01-'+plan['operationId'][:24]
        need(not aws.task_arns(startedBy=started), 'EXISTING_TASK_RECONCILE')
        journal.update(status='RUN_INTENT',startedBy=started); save(args.out,journal)
        response = aws.call('ecs','run_task',cluster=CLUSTER,launchType='FARGATE',taskDefinition=arn,
          networkConfiguration=snap['service']['networkConfiguration'],platformVersion=snap['service'].get('platformVersion','LATEST'),
          count=1,startedBy=started,clientToken=sha((claimed_hash+args.mode).encode()),overrides=overrides)
        need(not response.get('failures') and len(response.get('tasks',[]))==1, 'RUN_ACK_UNKNOWN')
        task_arn=response['tasks'][0].get('taskArn','')
        need(re.fullmatch(f'arn:aws:ecs:{REGION}:{ACCOUNT}:task/{CLUSTER}/[a-f0-9]+',task_arn), 'RUN_TASK_ID_UNKNOWN')
        journal.update(status='RUNNING',taskArn=task_arn); save(args.out,journal)
        deadline=time.monotonic()+900
        while time.monotonic()<deadline:
            task=aws.tasks([task_arn])[0]
            container=task_identity(task,task_arn,arn,overrides,proof['imageDigest'])
            if task.get('lastStatus')=='STOPPED': break
            time.sleep(5)
        else: raise Refusal('WAIT_TIMEOUT_TASK_MAY_STILL_RUN')
        journal.update(status='STOPPED',containerExitCode=container.get('exitCode')); save(args.out,journal)
        need(container.get('imageDigest')==proof['imageDigest'] and container.get('lastStatus')=='STOPPED', 'STOPPED_RUNTIME_UNQUALIFIED')
        options=request['containerDefinitions'][0]['logConfiguration']['options']
        stream=options['awslogs-stream-prefix']+'/'+CONTAINER+'/'+task_arn.rsplit('/',1)[1]
        # CloudWatch delivery may follow STOPPED. These bounded read-only polls
        # never repeat the task or a database command. Save partial journals too.
        for attempt in range(6):
            messages=aws.logs(options['awslogs-group'],stream)
            journal['logMessageCount']=len(messages)
            journal['ownerReceipts']=owner_receipts(messages,args.mode,False)
            save(args.out,journal)
            if container.get('exitCode') != 0 and journal['ownerReceipts']: break
            try:
                owner_receipts(messages,args.mode); break
            except Refusal:
                if attempt==5: raise
                time.sleep(5)
        # Never copy raw service logs or exception payloads. Only source-owned
        # prefixed structured receipts pass the sensitive-field filter.
        need(container.get('exitCode')==0, 'OWNER_PROCESS_FAILED')
        owner_receipts(messages,args.mode)
        journal['status']='VERIFIED'; save(args.out,journal)
        return {'status':'VERIFIED','mode':args.mode,'containerExitCode':0,'receiptCount':len(journal['ownerReceipts'])}
    except Exception as exc:
        journal['status']='RECONCILIATION_REQUIRED'
        journal['code']=str(exc) if isinstance(exc,Refusal) else 'AWS_OR_VERIFICATION_FAILED_OUTCOME_UNCERTAIN'
        save(args.out,journal)
        raise Refusal(journal['code']) from None

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','run']); parser.add_argument('--mode',choices=MODES,required=True)
    for name in ('repo','proof','proof-sha256','input','input-sha256','out'): parser.add_argument('--'+name,required=True)
    parser.add_argument('--plan'); parser.add_argument('--plan-sha256'); parser.add_argument('--confirm'); parser.add_argument('--profile',default='default')
    args=parser.parse_args(); a=adapter(); helper,_=a.load_helpers(args.repo); aws=a.Aws(args.profile)
    try:
        result=prepare(a,helper,aws,args) if args.action=='prepare' else run(a,helper,aws,args)
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({'status':'BLOCKED','code':str(exc) if isinstance(exc,Refusal) else 'OPERATOR_REFUSED'}))
        return 1
    return 0
if __name__=='__main__': raise SystemExit(main())
