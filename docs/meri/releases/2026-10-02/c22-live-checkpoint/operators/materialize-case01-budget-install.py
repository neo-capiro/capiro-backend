"""Fixed local-only input derivation from reviewed actual case01 receipts.

No AWS, DB, credentials, providers, or subprocesses. Does not execute installation.
"""
import argparse, hashlib, importlib.util, json, pathlib, re, time

ROOT = pathlib.Path(__file__).resolve().parent
OLD = ROOT.parent / 'oct02-case01-release'
SOURCE = 'c22d059e4fc8fd73f93e6928f7db3a1a4338f7f8'
PROOF_SHA = 'fcb9f085721fb17c33ef01f8005304f6478168b2dbef008c15e762a4deca446c'
BASE_SHA = '4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
INPUT_SHA = 'dc7cfd41ef037f8b594c7b6716bbd4c21da16a257cb4297f01567ef1399deb4b'
RATE_SHA = '2b5a3dc5565d1202d2905e9768689ed67174282d1f6263002b294b7b3b4f0f9d'
PLAN = OLD / 'budget-plan-c22-task-plan.json'
EXECUTION = OLD / 'budget-plan-c22-execution.json'
RECOVERY = OLD / 'case01-recovery-execute-execution.json'
OUTPUT = OLD / 'budget-install-c22-input.json'
HASH = re.compile('[a-f0-9]{64}')

class Refusal(Exception): pass
def need(ok, code):
    if not ok: raise Refusal(code)
def sha(value): return hashlib.sha256(value).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def digest(value): return sha(canonical(value).encode())
def pairs(items):
    result = {}
    for key, value in items:
        need(key not in result, 'DUPLICATE_JSON_KEY'); result[key] = value
    return result
def pinned(path, expected):
    need(isinstance(expected, str) and HASH.fullmatch(expected), 'REVIEWED_HASH_REQUIRED')
    raw = path.read_bytes()
    need(sha(raw) == expected, 'PINNED_INPUT_CHANGED')
    return json.loads(raw.decode('utf-8-sig'), object_pairs_hook=pairs)

def derive(plan, execution, recovery, original, rate, now):
    body = {key:value for key,value in plan.items() if key != 'planHash'}
    need(plan.get('planHash') == digest(body) and plan.get('mode') == 'budget-plan'
         and plan.get('sourceSha') == SOURCE and plan.get('proofSha256') == PROOF_SHA
         and plan.get('operatorSha256') == BASE_SHA and plan.get('inputSha256') == INPUT_SHA
         and plan.get('createdAt', 0) <= now < plan.get('expiresAt', 0), 'ACTUAL_FRESH_PLAN_REQUIRED')
    need(execution.get('status') == 'VERIFIED' and execution.get('mode') == 'budget-plan'
         and execution.get('sourceSha') == SOURCE and execution.get('containerExitCode') == 0
         and execution.get('planHash') == plan['planHash'] and execution.get('operationId') == plan.get('operationId')
         and execution.get('operatorHead') == plan.get('operatorHead')
         and re.fullmatch(r'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/[a-f0-9]{32}', execution.get('taskArn',''))
         and len(execution.get('ownerReceipts', [])) == 1, 'VERIFIED_BUDGET_PLAN_REQUIRED')
    need(recovery.get('status') == 'VERIFIED' and recovery.get('mode') == 'setup-recovery-execute'
         and recovery.get('sourceSha') == SOURCE and recovery.get('containerExitCode') == 0, 'RECOVERY_NOT_COMPLETE')
    completed = [row.get('receipt') for row in recovery.get('ownerReceipts', []) if row.get('stage') == 'COMPLETE' and row.get('phase') == 'VERIFIED']
    need(len(completed) == 1, 'RECOVERY_OWNER_REQUIRED')
    setup, owner = completed[0], execution['ownerReceipts'][0]
    need(setup.get('kind') == 'meri-case01-execution-setup-receipt' and setup.get('status') == 'SETUP_COMPLETE'
         and setup.get('synthesisSubmissionCount') == 0 and setup.get('ctx',{}).get('role') == 'standard_user'
         and original.get('ctx',{}).get('tenantId') == setup.get('ctx',{}).get('tenantId')
         and original.get('ctx',{}).get('userId') == setup.get('ctx',{}).get('userId')
         and original.get('clientId') == setup.get('clientId'), 'RECOVERY_INPUT_IDENTITY_CHANGED')
    need(set(owner) == set('status caseId captureRunId currentVerifySha256 captureBindingSha256 priorQualificationSha256 tenantRowVersion liveAcceptance'.split())
         and owner['status'] == 'READY_FOR_RATE_QUALIFICATION' and owner['caseId'] == '01'
         and owner['liveAcceptance'] == 'NOT_RUN' and owner['captureRunId'] == setup.get('captureRunId')
         and owner['currentVerifySha256'] == setup.get('currentVerifySha256')
         and owner['captureBindingSha256'] == setup.get('bindingSha256') == digest(setup.get('binding'))
         and owner['priorQualificationSha256'] == digest(None)
         and re.fullmatch('[0-9]+', owner['tenantRowVersion'] or '')
         and all(HASH.fullmatch(owner[key] or '') for key in ['currentVerifySha256','captureBindingSha256','priorQualificationSha256']), 'CURRENT_CANONICAL_BINDING_REQUIRED')
    from datetime import datetime
    when = lambda value: datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
    need(rate.get('kind') == 'meri-capture-reviewed-provider-rates' and rate.get('version') == 1
         and rate.get('priceKind') == 'qualified_text_token_upper_bound' and rate.get('maxTokens') == 200000
         and when(rate['observedAt']) <= now and when(rate['expiresAt']) >= now + 1800
         and len(rate.get('rates', [])) == 4, 'CURRENT_REVIEWED_RATES_REQUIRED')
    qualification = {'version':1,'caseId':'01','captureRunId':owner['captureRunId'],
      'currentVerifySha256':owner['currentVerifySha256'],'rateEvidenceSha256':digest(rate),
      'rateEvidenceExpiresAt':rate['expiresAt'],'priceKind':rate['priceKind'],
      'maxAttempts':32,'maxTokens':rate['maxTokens'],'maxCostMicros':3000000,'rates':rate['rates']}
    return {**original,'qualification':qualification,'rateEvidence':rate,
      'expectedCurrentVerifySha256':owner['currentVerifySha256'],
      'expectedCaptureBindingSha256':owner['captureBindingSha256'],
      'expectedPriorQualificationSha256':owner['priorQualificationSha256'],
      'expectedTenantRowVersion':owner['tenantRowVersion']}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan-execution-sha256',required=True)
    parser.add_argument('--recovery-execution-sha256',required=True)
    args=parser.parse_args()
    need(not OUTPUT.exists(), 'NEW_INPUT_PATH_REQUIRED')
    pinned(ROOT/'api-oneoff-build-proof.json', PROOF_SHA)
    original=pinned(OLD/'budget-plan-input.json', INPUT_SHA)
    rate=pinned(ROOT.parent/'oct02-original-eval'/'reviewed-rate-evidence-20261002.json', RATE_SHA)
    execution=pinned(EXECUTION,args.plan_execution_sha256)
    recovery=pinned(RECOVERY,args.recovery_execution_sha256)
    # Parse this single captured byte array; planHash below authenticates the same object.
    plan=json.loads(PLAN.read_bytes().decode('utf-8-sig'),object_pairs_hook=pairs)
    result=derive(plan,execution,recovery,original,rate,time.time())
    base_path=OLD/'case01-oneoff.py'
    need(sha(base_path.read_bytes()) == BASE_SHA,'FROZEN_OPERATOR_CHANGED')
    spec=importlib.util.spec_from_file_location('fixed_budget_sanitizer',base_path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.sanitize(result)
    need(len(canonical(result).encode()) <= 6000,'INPUT_BYTE_LIMIT')
    overrides={'containerOverrides':[{'name':module.CONTAINER,'command':['meri-capture-provider-budget','install','--input-env','MERI_CAPTURE_PROVIDER_BUDGET_INPUT','--out','/dev/shm/meri-case01-owner-receipt.jsonl'],
      'environment':[{'name':'MERI_CAPTURE_PROVIDER_BUDGET_INPUT','value':canonical(result)}]}]}
    need(len(canonical(overrides).encode()) <= 8192,'OVERRIDE_BYTE_LIMIT')
    raw=(json.dumps(result,indent=2,ensure_ascii=False)+'\n').encode()
    with OUTPUT.open('xb') as out:out.write(raw)
    print(json.dumps({'status':'LOCAL_BUDGET_INPUT_PREPARED','path':str(OUTPUT),'sha256':sha(raw),
      'maxCostMicros':3000000,'maxTokens':200000,'maxAttempts':32,'networkCalls':0,'liveAcceptance':'NOT_RUN'}))
    return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status':'BLOCKED','code':str(error) if isinstance(error,Refusal) else 'LOCAL_INPUT_DERIVATION_FAILED'}));raise SystemExit(1)
