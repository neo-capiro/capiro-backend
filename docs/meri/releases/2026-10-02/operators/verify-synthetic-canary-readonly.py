"""Independent read-only verification after root completes the bounded canary.

Imports only reviewed observation helpers. An allowlist blocks every cloud write.
Raw definitions, environment, and log messages remain in process memory.
"""
from __future__ import annotations
import argparse, copy, datetime, hashlib, importlib.util, json, pathlib, subprocess, sys

DIR = pathlib.Path(__file__).parent
REPO = pathlib.Path(r'C:\dev\cap-meri-outcomes-validation')
RELEASE = DIR.parent / 'oct02-release'
POLICY = '39590a3bfc57ce03b0411ff7912a7c8d99deb70c'
ORIGINAL_PLAN_HASH = 'e529bba8de8af5d66aabd3358446516587e89cbc180ed1c00a0bbb6dec7e2cbe'
PLAN_HASH = '8c7c1d033a1b90a9c3c5a45775d683d9a7b88da89746536a1ca42972859cd6fe'
ORIGINAL_ADAPTER_HASH = '0d1e3c1350c5bae336ada16b5aa396e75d5e120b41ecdbdd1e63b4b05d3e739e'
ADAPTER_HASH = '02098e0d9209f7313a66c4e73eb0689332af2edd7ba2a2ecf6e6daa58b0671f6'
CALLS = []
ALLOWED = {('sts','get_caller_identity'), ('ecs','describe_services'),
           ('ecs','describe_task_definition'), ('ecs','list_tasks'),
           ('ecs','describe_tasks'), ('elbv2','describe_target_health'),
           ('logs','get_log_events')}

def need(ok, reason):
    if not ok: raise RuntimeError(reason)

def sha(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

def load_adapter():
    path = DIR / 'synthetic-canary-codebuild.py'
    need(sha(path) == ADAPTER_HASH, 'Reviewed observation adapter changed')
    raw = path.read_bytes()
    start = raw.index(b'    def call(self, namespace, operation, **kwargs):')
    end = raw.index(b'    def identity', start)
    reconstructed = raw[:start]+raw[start:end].replace(b'namespace',b'service')+raw[end:]
    need(hashlib.sha256(reconstructed).hexdigest() == ORIGINAL_ADAPTER_HASH, 'Adapter delta is not the exact argument rename')
    spec = importlib.util.spec_from_file_location('verified_canary_observation_adapter', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def dark(adapter, container):
    key = 'RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED'
    need(not container.get('environmentFiles'), 'Mutable environment file blocks explicit dark-state proof')
    env = adapter.unique(container.get('environment'), 'value')
    secrets = adapter.unique(container.get('secrets'), 'valueFrom')
    need(key not in secrets and env.get(key, '') in ('','false','0'), 'RP tools flag not proven dark')
    return {'name':key, 'observed':env.get(key,'absent'), 'dark':True}

def cli(service, operation, **kwargs):
    need((service,operation) in ALLOWED, 'Read-only CLI allowlist refused operation')
    command = ['C:/Program Files/Amazon/AWSCLIV2/aws.exe', service, operation.replace('_','-'),
               '--region','us-east-1','--output','json','--cli-input-json',json.dumps(kwargs)]
    run = subprocess.run(command,capture_output=True,encoding='utf-8')
    CALLS.append({'transport':'aws-cli','command':service+'.'+operation,'exitCode':run.returncode})
    need(run.returncode == 0, 'Read-only AWS CLI failed; raw output withheld')
    return json.loads(run.stdout)

def policy_hashes(service, definition):
    # Use the exact original JS normalization; raw input never written to disk.
    source = """import fs from 'node:fs';
import {taskInput,fingerprint,serviceConfigFingerprint,serviceFingerprint} from 'file:///C:/dev/cap-meri-outcomes-validation/scripts/lib/meri-release-policy.mjs';
const p=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify({taskHash:fingerprint(taskInput({...p.definition.taskDefinition,tags:p.definition.tags??[]})),configHash:serviceConfigFingerprint(p.service),serviceHash:serviceFingerprint(p.service)}));"""
    run = subprocess.run(['node','--input-type=module','-e',source],input=json.dumps({'service':service,'definition':definition}),capture_output=True,encoding='utf-8',cwd=REPO)
    need(run.returncode == 0, 'Original release policy normalization failed; raw output withheld')
    return json.loads(run.stdout)

def unchanged_scope(adapter):
    baseline = adapter.read_json(RELEASE / 'three-service-verification-baseline.json')
    output = {}
    for key, old in [('web',baseline['canonicalWeb']),('engagement-api',baseline['engagement'])]:
        response = cli('ecs','describe_services',cluster='capiro-dev',services=['capiro-dev-'+key])
        need(not response.get('failures') and len(response.get('services',[])) == 1, 'Scope service readback ambiguous')
        service = response['services'][0]
        need(service['taskDefinition'] == old['taskDefinition'], 'Out-of-scope task definition changed')
        definition = cli('ecs','describe_task_definition',taskDefinition=service['taskDefinition'],include=['TAGS'])
        hashes = policy_hashes(service,definition)
        need(hashes['taskHash'] == old['taskHash'] and hashes['configHash'] == old['configHash'], 'Out-of-scope task/configuration changed')
        if key == 'web': need(hashes['serviceHash'] == old['serviceHash'], 'Canonical Web service identity changed')
        target = [c for c in definition['taskDefinition']['containerDefinitions'] if c['name'] == key]
        need(len(target) == 1, 'Out-of-scope target ambiguous')
        output[key] = {'unchangedSince':baseline['observedAt'],'taskDefinition':service['taskDefinition'],**hashes,'rpFlag':dark(adapter,target[0])}
    return output

def verify(args):
    adapter = load_adapter()
    original = adapter.read_json(DIR/'synthetic-canary-plan-v3.json')
    plan_path = DIR/'synthetic-canary-plan-v4.json'
    plan = adapter.read_json(plan_path)
    receipt_path = pathlib.Path(args.receipt)
    receipt = adapter.read_json(receipt_path)
    need(original['planHash'] == ORIGINAL_PLAN_HASH == adapter.digest({k:v for k,v in original.items() if k!='planHash'}), 'Original reviewed plan integrity mismatch')
    need(plan['planHash'] == PLAN_HASH == adapter.digest({k:v for k,v in plan.items() if k!='planHash'}), 'Resume plan integrity mismatch')
    allowed_plan_changes = {'planHash','adapterSha256','createdAtEpoch','expiresAtEpoch','operationId'}
    need({k:v for k,v in plan.items() if k not in allowed_plan_changes} == {k:v for k,v in original.items() if k not in allowed_plan_changes}, 'Resume plan changes approved target/configuration/proofs')
    need(plan['adapterSha256'] == ADAPTER_HASH and original['adapterSha256'] == ORIGINAL_ADAPTER_HASH, 'Plan adapter provenance mismatch')
    need(receipt.get('status') == 'VERIFIED' and receipt.get('mode') == 'apply' and receipt.get('planHash') == plan['planHash'], 'Completed apply receipt required')
    if 'receiptHash' in receipt:
        need(receipt['receiptHash'] == adapter.digest({k:v for k,v in receipt.items() if k!='receiptHash'}), 'Apply receipt integrity mismatch')
    need(plan['tenants'] == [list(t) for t in adapter.TENANTS], 'Tenant scope mismatch')
    helper, fullchat = adapter.load_helpers(REPO)
    for name in ('meri-synthetic-cohort.py','meri-synthetic-fullchat.py'):
        current = (REPO/'scripts'/name).read_bytes().replace(b'\r\n',b'\n')
        original_source = adapter.git(REPO,'show',plan['operatorSourceSha']+':scripts/'+name)
        need(current == original_source, 'Owner observation source changed since approved plan')
    class ReadOnly(adapter.Aws):
        def call(self, aws_service, operation, **kwargs):
            need((aws_service,operation) in ALLOWED, 'Read-only SDK allowlist refused operation')
            result = super().call(aws_service,operation,**kwargs)
            CALLS.append({'transport':'boto3','command':aws_service+'.'+operation,'exitCode':0})
            return result
    aws = ReadOnly(None)
    aws.identity(plan['expectedCallerArn'])
    services, snapshots = [], {}
    need(set(receipt.get('services',{})) == set(adapter.SERVICES), 'Both and only approved services must have final entries')
    for key in adapter.SERVICES:
        before, entry = plan['services'][key], receipt['services'][key]
        need(entry.get('status') == 'VERIFIED', 'Canary service not verified by operator')
        need(entry.get('beforeTaskDefinition') == before['taskDefinition'] and entry.get('beforeHash') == before['taskDefinitionHash'] and entry.get('afterHash') == before['candidateHash'], 'Canary entry differs from approved before/after binding')
        live = adapter.snapshot(aws,helper,key,plan['proofs'][key]); adapter.check_targets(aws,live)
        snapshots[key] = live
        safe = live['safe']
        need(safe['taskDefinition'] == entry['afterTaskDefinition'] and safe['taskDefinitionHash'] == before['candidateHash'], 'Live candidate task identity/hash differs')
        need(safe['serviceConfigHash'] == before['serviceConfigHash'] and safe['desiredCount'] == before['desiredCount'], 'Service configuration/count changed beyond task revision')
        need(safe['primaryDeployment']['id'] == entry['deploymentId'] and safe['primaryDeployment']['rolloutState'] == 'COMPLETED' and len(live['service'].get('deployments',[])) == 1, 'Exact canary rollout is not complete')
        old_definition = aws.definition(before['taskDefinition'])
        need(adapter.digest(helper.task_registration_request(old_definition)) == before['taskDefinitionHash'], 'Original task definition differs from reviewed plan')
        exact_candidate, delta = adapter.transform(helper,old_definition,before['containerName'])
        need(delta == before['cohortChange'] and delta['added'] == list(adapter.TARGETS) and delta['beforeCount']==9 and delta['afterCount']==11, 'Cohort delta differs from exact two approved additions')
        need(exact_candidate == helper.task_registration_request(live['response']), 'Task delta contains changes beyond approved cohort additions')
        env = adapter.unique(live['container'].get('environment'),'value')
        need(env.get('GIT_SHA') == env.get('RELEASE_SHA') == plan['proofs'][key]['sourceSha'], 'Source metadata drift')
        services.append({'service':key,'taskDefinition':safe['taskDefinition'],'taskDefinitionHash':safe['taskDefinitionHash'],'deploymentId':entry['deploymentId'],'rolloutState':'COMPLETED','desired':live['service']['desiredCount'],'running':live['service']['runningCount'],'pending':live['service']['pendingCount'],'imageDigest':safe['imageDigest'],'sourceSha':plan['proofs'][key]['sourceSha'],'cohortChange':delta,'onlyTaskChange':'MERIV3_CANARY_TENANT_SLUGS adds the two explicitly approved synthetic slugs','rpFlag':dark(adapter,live['container']),'health':'Every actual running task IP matched the exact healthy application ALB target set'})
    jobs = receipt.get('flagJobs',[])
    need(len(jobs)==1, 'Exactly one authoritative apply flag job required')
    stopped = adapter.read_json(DIR/'synthetic-canary-apply-v3.json')
    need(stopped.get('status') == 'BLOCKED_RECONCILIATION_REQUIRED' and stopped.get('planHash') == original['planHash'] and stopped.get('flagJobs') == jobs and stopped.get('priorStates') == receipt.get('priorStates'), 'Resume must preserve the already successful apply job and original states')
    before, after = adapter.read_flag_result(aws,helper,fullchat,plan,snapshots['api'],jobs[0],'apply',receipt['priorStates'])
    need(before == receipt['priorStates'], 'Apply original flag states do not match actual log authority')
    need(len(after)==2 and {(s['tenantId'],s['tenantSlug']) for s in after} == set(adapter.TENANTS) and all(s['flag']=='meriv3.fullChat' and s['state']=={'present':True,'value':True} for s in after), 'Exact two flags are not verified true by actual apply log authority')
    web = adapter.verify_web(aws,plan['proofs']['web-vnext'])
    need(web == plan['web'], 'Qualified Web changed during canary')
    web_response = aws.definition(web['taskDefinition'])
    web_container = [c for c in web_response['taskDefinition']['containerDefinitions'] if c['name']=='web-vnext']
    need(len(web_container)==1,'Web target ambiguous')
    scopes = unchanged_scope(adapter)
    return {'verdict':'PASS','observedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'policySha':POLICY,'machineMapDate':'2026-09-30','adapterSha256':ADAPTER_HASH,'planHash':plan['planHash'],'sourceReceipt':str(receipt_path),'sourceReceiptSha256':sha(receipt_path),'services':services,'flagAuthority':{'taskDefinition':jobs[0]['taskDefinition'],'taskArn':jobs[0]['taskArn'],'actualExitCode':0,'actualImageDigest':plan['proofs']['api']['imageDigest'],'verifiedAgainstActualTaskDefinitionOverridesAndCloudWatchLogs':True,'before':before,'after':after,'freshDbQuery':'NOT RUN; flags are proved by the successful fixed apply task log'},'webVnext':{'unchanged':True,**web,'rpFlag':dark(adapter,web_container[0])},'scopePreservation':scopes,'rolloutHealth':'PASS','boundedUiQa':'NOT RUN','fullFile01Acceptance':'NOT RUN','externalWrites':0,'calls':CALLS}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--receipt',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    output=pathlib.Path(args.output);need(not output.exists(),'Preserve existing evidence output')
    try: result=verify(args); code=0
    except Exception as exc:
        result={'verdict':'BLOCKED','observedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reason':str(exc) if isinstance(exc,RuntimeError) else 'Read-only verification failed: '+type(exc).__name__,'externalWrites':0,'calls':CALLS};code=1
    with output.open('x',encoding='utf-8') as handle:json.dump(result,handle,indent=2)
    print(json.dumps({'verdict':result['verdict'],'receipt':str(output),'receiptSha256':sha(output),'readCalls':len(CALLS),'externalWrites':0,'reason':result.get('reason')}));return code

if __name__=='__main__':sys.exit(main())
