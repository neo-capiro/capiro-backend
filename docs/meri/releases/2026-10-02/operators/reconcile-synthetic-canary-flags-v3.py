"""Read-only rebind of one completed flag query after an exact adapter fix.

No task is registered or launched. The original receipt is never edited. This
script remains held until root reviews this source and supplies --execute-readonly.
"""
import copy,hashlib,importlib.util,json,pathlib,sys,time
ROOT=pathlib.Path(__file__).parent
REPO=r'C:\dev\cap-meri-outcomes-validation'
PATCH="    if overrides.get('inferenceAcceleratorOverrides') == []:\n        overrides.pop('inferenceAcceleratorOverrides')\n"
CHANGING_PLAN_FIELDS={'planHash','createdAtEpoch','expiresAtEpoch','operationId','adapterSha256'}

def verify_inputs(a,old_plan,new_plan,old_receipt,blocked_apply,old_source,new_source):
    for plan in (old_plan,new_plan):
        a.need(plan.get('schemaVersion')==a.SCHEMA and plan.get('planHash')==a.digest({k:v for k,v in plan.items() if k!='planHash'}),'plan integrity mismatch')
    a.need(set(old_plan)==set(new_plan),'plan shape changed')
    compared=sorted(set(old_plan)-CHANGING_PLAN_FIELDS)
    a.need(all(old_plan[key]==new_plan[key] for key in compared),'reviewed source/proofs/tenants/snapshots changed')
    a.need(old_plan['operationId']!=new_plan['operationId'],'reconciliation requires distinct new operation')
    a.need(hashlib.sha256(old_source).hexdigest()==old_plan['adapterSha256'] and hashlib.sha256(new_source).hexdigest()==new_plan['adapterSha256'],'adapter source hashes differ from plans')
    old_text=old_source.decode('utf-8').replace('\r\n','\n');new_text=new_source.decode('utf-8').replace('\r\n','\n')
    a.need(new_text.count(PATCH)==1 and new_text.replace(PATCH,'',1)==old_text,'adapter delta is not exactly the reviewed empty-array normalization')
    a.need(old_receipt.get('schemaVersion')==a.SCHEMA and old_receipt.get('mode')=='flag-plan' and old_receipt.get('status')=='VERIFIED' and old_receipt.get('planHash')==old_plan['planHash'],'original flag receipt is not verified for original plan')
    a.need(old_receipt.get('receiptHash')==a.digest({k:v for k,v in old_receipt.items() if k!='receiptHash'}),'original flag receipt integrity mismatch')
    jobs=old_receipt.get('flagJobs') or []
    a.need(len(jobs)==1 and jobs[0].get('mode')=='plan' and jobs[0].get('status')=='VERIFIED','one completed read-only flag task required')
    a.need(old_receipt.get('services')=={} and isinstance(old_receipt.get('priorStates'),list),'original receipt scope differs')
    a.need(blocked_apply.get('schemaVersion')==a.SCHEMA and blocked_apply.get('mode')=='apply' and blocked_apply.get('planHash')==old_plan['planHash'] and blocked_apply.get('status')=='BLOCKED_RECONCILIATION_REQUIRED' and blocked_apply.get('services')=={} and blocked_apply.get('flagJobs')==[],'old apply not reconciled as stopped before writes')
    return compared

def derive(a,aws,helper,fullchat,old_plan,new_plan,old_receipt,blocked_apply,qualification,old_source,new_source):
    compared=verify_inputs(a,old_plan,new_plan,old_receipt,blocked_apply,old_source,new_source)
    a.verify_plan(new_plan,qualification,REPO)
    aws.identity(qualification['expectedCallerArn'])
    a.need(a.verify_web(aws,new_plan['proofs']['web-vnext'])==new_plan['web'],'Web changed before reconciliation')
    snaps={name:a.snapshot(aws,helper,name,new_plan['proofs'][name]) for name in a.SERVICES}
    for name,snap in snaps.items():
        a.same_snapshot(snap,new_plan['services'][name]);a.check_targets(aws,snap)
    before,after=a.read_flag_result(aws,helper,fullchat,new_plan,snaps['api'],old_receipt['flagJobs'][0],'plan',None)
    a.need(before==after==old_receipt['priorStates'],'existing authoritative flag task differs from saved original states')
    result=copy.deepcopy(old_receipt);result.pop('receiptHash');result['planHash']=new_plan['planHash']
    result['reconciliation']={'schemaVersion':'meri.synthetic-flag-plan-reuse.v1','kind':'READ_ONLY_REUSE_EXISTING_TASK','sourcePlanHash':old_plan['planHash'],'sourceReceiptHash':old_receipt['receiptHash'],'destinationPlanHash':new_plan['planHash'],'oldAdapterSha256':old_plan['adapterSha256'],'newAdapterSha256':new_plan['adapterSha256'],'comparedEqualPlanFields':compared,'reusedTaskArn':old_receipt['flagJobs'][0]['taskArn'],'authoritativeReadbackAtEpoch':time.time(),'newTasksLaunched':0,'cloudMutations':0}
    result['receiptHash']=a.digest(result)
    return result

def main():
    if sys.argv[1:]!=['--execute-readonly']:raise SystemExit('explicit read-only execution gate required')
    spec=importlib.util.spec_from_file_location('adapter',ROOT/'synthetic-canary-codebuild.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
    try:
        target=ROOT/'synthetic-canary-flags-before-v3.json';a.need(not target.exists(),'derived receipt already exists')
        old_plan=a.read_json(ROOT/'synthetic-canary-plan-v2.json');new_plan=a.read_json(ROOT/'synthetic-canary-plan-v3.json')
        old_receipt=a.read_json(ROOT/'synthetic-canary-flags-before-v2.json');blocked=a.read_json(ROOT/'synthetic-canary-apply-v2.json');qualification=a.read_json(ROOT/'synthetic-canary-qualification.json')
        helper,fullchat=a.load_helpers(REPO)
        result=derive(a,a.Aws('default'),helper,fullchat,old_plan,new_plan,old_receipt,blocked,qualification,(ROOT/'synthetic-canary-codebuild-before-inference.py').read_bytes(),(ROOT/'synthetic-canary-codebuild.py').read_bytes())
        a.create_receipt(target,result)
        print(json.dumps({'status':'VERIFIED_READ_ONLY_REUSE','planHash':result['planHash'],'receiptHash':result['receiptHash'],'cloudMutations':0,'newTasksLaunched':0}))
        return 0
    except Exception as error:
        print(json.dumps({'status':'BLOCKED','safeReason':str(error) if isinstance(error,a.Refusal) else type(error).__name__,'cloudMutations':0}))
        return 2

if __name__=='__main__':raise SystemExit(main())
