"""Fixed budget plan/install after the exact completed case01 continuation.
Local materialization has no AWS calls. Preparation is read-only; root owns run.
"""
import argparse,hashlib,importlib.util,json,pathlib,re,time
from datetime import datetime
ROOT=pathlib.Path(__file__).resolve().parent
BASE=ROOT/'case01-oneoff.py'
BASE_SHA='4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
CONTINUATION=ROOT/'case01-continuation-oneoff.py'
CONTINUATION_SHA='040e448a656e17a8c9e9d99cd8c97a74c7ef3ace51be3517e383520ee697785e'
ORIGINAL=ROOT/'budget-plan-input.json'
ORIGINAL_SHA='dc7cfd41ef037f8b594c7b6716bbd4c21da16a257cb4297f01567ef1399deb4b'
RATE=ROOT.parent/'oct02-original-eval'/'reviewed-rate-evidence-20261002.json'
RATE_SHA='2b5a3dc5565d1202d2905e9768689ed67174282d1f6263002b294b7b3b4f0f9d'
INPUTS={mode:ROOT/('budget-'+mode.removeprefix('budget-')+'-continuation-input.json') for mode in ['budget-plan','budget-install']}
PLANS={mode:ROOT/('budget-'+mode.removeprefix('budget-')+'-continuation-task-plan.json') for mode in INPUTS}
EXECUTIONS={mode:ROOT/('budget-'+mode.removeprefix('budget-')+'-continuation-execution.json') for mode in INPUTS}

def load(path,name,expected):
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise RuntimeError('FROZEN_OPERATOR_CHANGED')
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def load_operator(mode):
    m=load(BASE,'continuation_budget_base',BASE_SHA)
    c=load(CONTINUATION,'completed_continuation_owner',CONTINUATION_SHA);co=c.load_operator(c.EXECUTE_MODE)
    m.need(mode in INPUTS,'FIXED_BUDGET_MODE');m.__file__=__file__
    old_qualify=m.qualify
    m.source_check=co.source_check

    def read(path,expected=None):
        data=pathlib.Path(path).read_bytes()
        if expected is not None:m.need(isinstance(expected,str) and re.fullmatch('[a-f0-9]{64}',expected) and m.sha(data)==expected,'PINNED_RECEIPT_CHANGED')
        def pairs(items):
            result={}
            for key,value in items:m.need(key not in result,'DUPLICATE_JSON_KEY');result[key]=value
            return result
        return json.loads(data.decode('utf-8-sig'),object_pairs_hook=pairs)

    def actual_receipt(path,plan_path,expected_hash,expected_mode,operator_sha):
        receipt,plan=read(path,expected_hash),read(plan_path)
        body=dict(plan);claimed=body.pop('planHash',None)
        m.need(claimed==m.digest(body) and plan.get('operatorSha256')==operator_sha and plan.get('mode')==expected_mode,'OWNER_TASK_PLAN_INVALID')
        m.need(receipt.get('status')=='VERIFIED' and receipt.get('mode')==expected_mode and receipt.get('containerExitCode')==0
               and receipt.get('planHash')==claimed and receipt.get('sourceSha')==plan.get('sourceSha')
               and receipt.get('operationId')==plan.get('operationId') and receipt.get('operatorHead')==plan.get('operatorHead')
               and re.fullmatch(r'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/[a-f0-9]{32}',receipt.get('taskArn','')),'OWNER_EXECUTION_INVALID')
        return receipt,plan

    def completed(expected_hash):
        receipt,plan=actual_receipt(c.EXECUTIONS[c.EXECUTE_MODE],c.TASK_PLANS[c.EXECUTE_MODE],expected_hash,c.EXECUTE_MODE,CONTINUATION_SHA)
        entries=co.owner_receipts([co.PREFIX['setup']+json.dumps(row) for row in receipt.get('ownerReceipts',[])],c.EXECUTE_MODE)
        return receipt,plan,entries[-1]['receipt']

    def validate_plan(owner,setup):
        m.need(isinstance(owner,dict) and set(owner)==set('status caseId captureRunId currentVerifySha256 captureBindingSha256 priorQualificationSha256 tenantRowVersion liveAcceptance'.split())
               and owner.get('status')=='READY_FOR_RATE_QUALIFICATION' and owner['caseId']=='01'
               and owner['captureRunId']==setup['captureRunId'] and owner['currentVerifySha256']==setup['currentVerifySha256']
               and owner['captureBindingSha256']==setup['bindingSha256'] and owner['priorQualificationSha256']==m.digest(None)
               and re.fullmatch('[0-9]{1,15}',owner['tenantRowVersion'] or '') and owner['liveAcceptance']=='NOT_RUN','CURRENT_BINDING_PLAN_INVALID')
        return owner

    def plan_result(expected_hash,setup):
        receipt,plan=actual_receipt(EXECUTIONS['budget-plan'],PLANS['budget-plan'],expected_hash,'budget-plan',m.file_sha(__file__))
        m.need(len(receipt.get('ownerReceipts',[]))==1,'BUDGET_PLAN_RECEIPT_COUNT')
        return receipt,plan,validate_plan(receipt['ownerReceipts'][0],setup)

    def derive(continuation_hash,plan_hash=None):
        cr,cp,setup=completed(continuation_hash);original=read(ORIGINAL,ORIGINAL_SHA)
        m.need(original['ctx']['tenantId']==setup['ctx']['tenantId'] and original['ctx']['userId']==setup['ctx']['userId']
               and original['ctx']['role']==setup['ctx']['role']=='standard_user' and original['clientId']==setup['clientId'],'BUDGET_ACTOR_CHANGED')
        envelope={'continuationExecutionSha256':continuation_hash,'ownerInput':original}
        if plan_hash is None:return envelope
        br,bp,owner=plan_result(plan_hash,setup)
        m.need(br['sourceSha']==cr['sourceSha'] and bp['imageDigest']==cp['imageDigest']
               and bp['createdAt']<=time.time()<bp['expiresAt'],'FRESH_SAME_IMAGE_PLAN_REQUIRED')
        rate=read(RATE,RATE_SHA);when=lambda value:datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
        m.need(rate.get('kind')=='meri-capture-reviewed-provider-rates' and rate.get('version')==1
               and rate.get('priceKind')=='qualified_text_token_upper_bound' and rate.get('maxTokens')==200000
               and when(rate['observedAt'])<=time.time() and when(rate['expiresAt'])>=time.time()+1800
               and len(rate.get('rates',[]))==4,'CURRENT_REVIEWED_RATES_REQUIRED')
        q={'version':1,'caseId':'01','captureRunId':owner['captureRunId'],'currentVerifySha256':owner['currentVerifySha256'],
           'rateEvidenceSha256':m.digest(rate),'rateEvidenceExpiresAt':rate['expiresAt'],'priceKind':rate['priceKind'],
           'maxAttempts':32,'maxTokens':200000,'maxCostMicros':3000000,'rates':rate['rates']}
        envelope['budgetPlanExecutionSha256']=plan_hash
        envelope['ownerInput']={**original,'qualification':q,'rateEvidence':rate,
          'expectedCurrentVerifySha256':owner['currentVerifySha256'],'expectedCaptureBindingSha256':owner['captureBindingSha256'],
          'expectedPriorQualificationSha256':owner['priorQualificationSha256'],'expectedTenantRowVersion':owner['tenantRowVersion']}
        return envelope

    def input_binding(selected,path,expected_hash):
        m.need(selected in INPUTS and pathlib.Path(path).resolve()==INPUTS[selected],'FIXED_INPUT_PATH')
        envelope=read(path,expected_hash);m.sanitize(envelope)
        keys={'continuationExecutionSha256','ownerInput'}|({'budgetPlanExecutionSha256'} if selected=='budget-install' else set())
        m.need(set(envelope)==keys,'BUDGET_INPUT_FIELDS')
        expected=derive(envelope['continuationExecutionSha256'],envelope.get('budgetPlanExecutionSha256'))
        m.need(envelope==expected,'CANONICAL_BUDGET_INPUT_CHANGED')
        owner=m.canonical(envelope['ownerInput']);m.need(0<len(owner.encode())<=6000,'INPUT_BYTE_LIMIT')
        verb,action,variable=m.MODES[selected]
        overrides={'containerOverrides':[{'name':m.CONTAINER,'command':[verb,action,'--input-env',variable,'--out','/dev/shm/meri-case01-owner-receipt.jsonl'],
          'environment':[{'name':variable,'value':owner}]}]}
        m.need(len(m.canonical(overrides).encode())<=8192,'OVERRIDE_BYTE_LIMIT')
        return envelope,overrides

    def owner_receipts(messages,selected,require_success=True):
        envelope,_=input_binding(selected,INPUTS[selected],m.file_sha(INPUTS[selected]));_,_,setup=completed(envelope['continuationExecutionSha256'])
        entries=[]
        for message in messages:
            for line in message.splitlines():
                if not line.startswith(m.PREFIX['budget']):continue
                m.need(len(line.encode())<=20000,'OWNER_RECEIPT_SIZE');owner=json.loads(line[len(m.PREFIX['budget']):]);m.sanitize(owner)
                if selected=='budget-plan':validate_plan(owner,setup)
                else:
                    value=envelope['ownerInput'];q=value['qualification']
                    expected={'status':'PROVIDER_QUALIFICATION_INSTALLED','tenantId':value['ctx']['tenantId'],'clientId':value['clientId'],
                      'captureRunId':q['captureRunId'],'currentVerifySha256':q['currentVerifySha256'],
                      'captureBindingSha256':value['expectedCaptureBindingSha256'],'qualificationSha256':m.digest(q),
                      'priorQualificationSha256':value['expectedPriorQualificationSha256'],'maxCostMicros':3000000,
                      'rateEvidenceSha256':q['rateEvidenceSha256'],'rateEvidenceExpiresAt':q['rateEvidenceExpiresAt'],'liveAcceptance':'NOT_RUN'}
                    m.need(set(owner)==set(expected)|{'tenantRowVersion'} and all(owner[k]==v for k,v in expected.items())
                           and re.fullmatch('[0-9]{1,15}',owner['tenantRowVersion'] or ''),'INSTALLED_QUALIFICATION_INVALID')
                entries.append(owner)
        m.need(len(entries)<=1,'OWNER_RECEIPT_COUNT')
        if require_success:m.need(len(entries)==1,'OWNER_RECEIPT_REQUIRED')
        return entries

    def verify_task(a,repo,aws,proof,receipt,plan,overrides,validate_logs):
        m.need(receipt['sourceSha']==proof['sourceSha'] and plan['imageDigest']==proof['imageDigest'],'OWNER_IMAGE_DRIFT')
        tasks=aws.tasks([receipt['taskArn']]);m.need(len(tasks)==1,'OWNER_TASK_MISSING');task=tasks[0]
        container=m.task_identity(task,receipt['taskArn'],receipt['taskDefinition'],overrides,proof['imageDigest'])
        m.need(task.get('lastStatus')=='STOPPED' and container.get('lastStatus')=='STOPPED' and container.get('exitCode')==0
               and container.get('imageDigest')==proof['imageDigest'],'OWNER_TASK_NOT_SUCCESSFUL')
        helper,_=a.load_helpers(repo);request=helper.task_registration_request(aws.definition(receipt['taskDefinition']))
        m.need(m.digest(m.definition_projection(a,request))==plan['oneOffDefinitionHash'],'OWNER_TASK_DEFINITION_CHANGED')
        opts=request['containerDefinitions'][0]['logConfiguration']['options'];stream=opts['awslogs-stream-prefix']+'/'+m.CONTAINER+'/'+receipt['taskArn'].rsplit('/',1)[1]
        m.need(validate_logs(aws.logs(opts['awslogs-group'],stream))==receipt['ownerReceipts'],'OWNER_LOGS_CHANGED')

    def qualify(a,repo,aws,proof_file,proof_hash):
        proof=old_qualify(a,repo,aws,proof_file,proof_hash)
        envelope,_=input_binding(mode,INPUTS[mode],m.file_sha(INPUTS[mode]))
        cr,cp,_=completed(envelope['continuationExecutionSha256'])
        _,overrides=co.input_binding(c.EXECUTE_MODE,c.INPUTS[c.EXECUTE_MODE],m.file_sha(c.INPUTS[c.EXECUTE_MODE]))
        verify_task(a,repo,aws,proof,cr,cp,overrides,lambda logs:co.owner_receipts(logs,c.EXECUTE_MODE))
        if mode=='budget-install':
            _,_,setup=completed(envelope['continuationExecutionSha256']);br,bp,_=plan_result(envelope['budgetPlanExecutionSha256'],setup)
            _,overrides=input_binding('budget-plan',INPUTS['budget-plan'],m.file_sha(INPUTS['budget-plan']))
            verify_task(a,repo,aws,proof,br,bp,overrides,lambda logs:owner_receipts(logs,'budget-plan'))
        return proof

    m.derive,m.completed,m.plan_result=derive,completed,plan_result
    m.input_binding,m.owner_receipts,m.qualify=input_binding,owner_receipts,qualify
    m.verify_task=verify_task
    return m

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['materialize-plan-input','materialize-install-input','prepare','run'])
    parser.add_argument('--mode',choices=list(INPUTS),required=True)
    for name in ['continuation-execution-sha256','budget-plan-execution-sha256','repo','proof','proof-sha256','input','input-sha256','out','plan','plan-sha256','confirm']:parser.add_argument('--'+name)
    args=parser.parse_args();m=load_operator(args.mode)
    try:
        if args.action.startswith('materialize-'):
            install=args.action=='materialize-install-input'
            m.need(args.mode==('budget-install' if install else 'budget-plan'),'MATERIALIZATION_MODE')
            if install:m.need(args.budget_plan_execution_sha256,'ACTUAL_PLAN_HASH_REQUIRED')
            value=m.derive(args.continuation_execution_sha256,args.budget_plan_execution_sha256 if install else None)
            m.create(INPUTS[args.mode],value)
            print(json.dumps({'status':'LOCAL_BUDGET_INPUT_PREPARED','path':str(INPUTS[args.mode]),'sha256':m.file_sha(INPUTS[args.mode]),'networkCalls':0}));return 0
        m.need(all(getattr(args,name) for name in ['repo','proof','proof_sha256','input','input_sha256','out']),'ARGUMENTS_REQUIRED')
        m.need(pathlib.Path(args.out).resolve()==(PLANS[args.mode] if args.action=='prepare' else EXECUTIONS[args.mode]),'FIXED_OUTPUT_REQUIRED')
        if args.action=='run':m.need(args.plan and pathlib.Path(args.plan).resolve()==PLANS[args.mode],'FIXED_PLAN_REQUIRED')
        a=m.adapter();helper,_=a.load_helpers(args.repo);aws=a.Aws('default')
        result=m.prepare(a,helper,aws,args) if args.action=='prepare' else m.run(a,helper,aws,args)
        print(json.dumps(result));return 0
    except Exception as error:
        print(json.dumps({'status':'BLOCKED','code':str(error) if isinstance(error,m.Refusal) else 'CONTINUATION_BUDGET_REFUSED'}));return 1
if __name__=='__main__':raise SystemExit(main())
