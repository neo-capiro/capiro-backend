"""Bounded recovery: reuse completed flag apply and API486; never run a DB task."""
import copy,hashlib,importlib.util,json,pathlib,sys,time
ROOT=pathlib.Path(__file__).parent
REPO=r'C:\dev\cap-meri-outcomes-validation'
FAILED_APPLY_SHA256='1f774ede26145bb5b3af7bc10c6eebac89ca4892bcdfd5006ce1aeee3e352428'
API_CANDIDATE='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:486'
OLD_CALL="""    def call(self, service, operation, **kwargs):
        if service not in self.clients:
            self.clients[service] = self.session.client(service, config=self.config)
        try:
            return getattr(self.clients[service], operation)(**kwargs)
        except Exception as exc:
            raise Refusal(f'{service}.{operation} failed or acknowledgement uncertain') from exc
"""
NEW_CALL=OLD_CALL.replace('service','namespace')
PLAN_DELTA_FIELDS={'planHash','createdAtEpoch','expiresAtEpoch','operationId','adapterSha256'}

def verify_inputs(a,old_plan,new_plan,failed,failed_bytes,old_source,new_source):
    a.need(hashlib.sha256(failed_bytes).hexdigest()==FAILED_APPLY_SHA256,'failed receipt differs from reviewed bytes')
    a.need(json.loads(failed_bytes.decode('utf-8-sig'))==failed,'parsed failed receipt differs')
    for plan in (old_plan,new_plan):
        a.need(plan.get('schemaVersion')==a.SCHEMA and plan.get('planHash')==a.digest({k:v for k,v in plan.items() if k!='planHash'}),'plan integrity mismatch')
    a.need(set(old_plan)==set(new_plan),'plan shape changed')
    equal=sorted(set(old_plan)-PLAN_DELTA_FIELDS)
    a.need(all(old_plan[key]==new_plan[key] for key in equal),'source/proofs/tenants/configuration snapshots changed')
    a.need(old_plan['operationId']!=new_plan['operationId'],'new recovery operation required')
    a.need(hashlib.sha256(old_source).hexdigest()==old_plan['adapterSha256'] and hashlib.sha256(new_source).hexdigest()==new_plan['adapterSha256'],'adapter source hash mismatch')
    old=old_source.decode('utf-8').replace('\r\n','\n');new=new_source.decode('utf-8').replace('\r\n','\n')
    a.need(old.count(OLD_CALL)==1 and new==old.replace(OLD_CALL,NEW_CALL,1),'adapter delta is not exactly the reviewed call-parameter rename')
    a.need(failed.get('schemaVersion')==a.SCHEMA and failed.get('mode')=='apply' and failed.get('status')=='BLOCKED_RECONCILIATION_REQUIRED' and failed.get('errorClass')=='TypeError' and failed.get('planHash')==old_plan['planHash'],'failed apply provenance differs')
    a.need(set(failed.get('services',{}))=={'api'},'unexpected service mutation scope')
    entry=failed['services']['api'];baseline=old_plan['services']['api']
    a.need(entry.get('status')=='UPDATE_INTENT' and 'deploymentId' not in entry and entry.get('beforeTaskDefinition')==baseline['taskDefinition'] and entry.get('afterTaskDefinition')==API_CANDIDATE and entry.get('beforeHash')==baseline['taskDefinitionHash'] and entry.get('afterHash')==baseline['candidateHash'] and entry.get('desiredCount')==baseline['desiredCount'],'registered API candidate differs from reviewed failure')
    jobs=failed.get('flagJobs') or []
    a.need(len(jobs)==1 and jobs[0].get('mode')=='apply' and jobs[0].get('status')=='VERIFIED' and isinstance(failed.get('priorStates'),list),'one verified completed flag apply required')
    return equal

def qualify(a,aws,helper,fullchat,old_plan,plan,failed,qualification,failed_bytes,old_source,new_source):
    equal=verify_inputs(a,old_plan,plan,failed,failed_bytes,old_source,new_source)
    a.verify_plan(plan,qualification,REPO)
    aws.identity(qualification['expectedCallerArn'])
    for name in plan['proofs']:
        a.need(a.qualify_build(aws,REPO,name,qualification['images'][name])==plan['proofs'][name],'CodeBuild provenance changed')
    a.need(a.verify_web(aws,plan['proofs']['web-vnext'])==plan['web'],'Web baseline changed')
    snaps={name:a.snapshot(aws,helper,name,plan['proofs'][name]) for name in a.SERVICES}
    for name,snap in snaps.items():
        a.same_snapshot(snap,plan['services'][name]);a.check_targets(aws,snap)
    before,after=a.read_flag_result(aws,helper,fullchat,plan,snaps['api'],failed['flagJobs'][0],'apply',failed['priorStates'])
    a.need(before==failed['priorStates'] and all(item['state']=={'present':True,'value':True} for item in after),'completed flag authority differs from original states or applied true')
    candidate=aws.definition(API_CANDIDATE)
    helper.validate_new_td_arn(a.SERVICES['api'],API_CANDIDATE)
    a.need(candidate.get('taskDefinition',{}).get('taskDefinitionArn')==API_CANDIDATE and a.digest(helper.task_registration_request(candidate))==plan['services']['api']['candidateHash'],'existing API486 no longer matches exact candidate hash')
    return snaps,equal

def resume(a,aws,helper,fullchat,old_plan,plan,failed,qualification,failed_bytes,old_source,new_source,output):
    snaps,equal=qualify(a,aws,helper,fullchat,old_plan,plan,failed,qualification,failed_bytes,old_source,new_source)
    a.need(not pathlib.Path(output).exists(),'recovery receipt exists; reconcile without retry')
    journal={'schemaVersion':a.SCHEMA,'mode':'apply','planHash':plan['planHash'],'status':'EXECUTION_STARTED','startedAtEpoch':time.time(),'services':{},'flagJobs':copy.deepcopy(failed['flagJobs']),'priorStates':copy.deepcopy(failed['priorStates']),
        'reconciliation':{'kind':'RESUME_COHORT_AFTER_COMPLETED_FLAG_APPLY','sourcePlanHash':old_plan['planHash'],'sourceApplyReceiptSha256':FAILED_APPLY_SHA256,'sourceAdapterSha256':old_plan['adapterSha256'],'newAdapterSha256':plan['adapterSha256'],'comparedEqualPlanFields':equal,'reusedFlagTaskArn':failed['flagJobs'][0]['taskArn'],'reusedApiTaskDefinition':API_CANDIDATE,'newDatabaseTasks':0,'revalidatedAtEpoch':time.time()}}
    a.claim_operation(plan,'apply');a.create_receipt(output,journal)
    try:
        # Submit each separately guarded same-image cohort update, then wait for
        # the two actual returned deployments; AWS may roll them concurrently.
        for name in a.SERVICES:
            safe=plan['services'][name];current=a.snapshot(aws,helper,name,plan['proofs'][name]);a.same_snapshot(current,safe);a.check_targets(aws,current)
            a.need(a.verify_web(aws,plan['proofs']['web-vnext'])==plan['web'],'Web baseline changed before update')
            entry={'status':'PREPARING','beforeTaskDefinition':safe['taskDefinition'],'beforeHash':safe['taskDefinitionHash'],'afterHash':safe['candidateHash'],'desiredCount':safe['desiredCount']};journal['services'][name]=entry
            if name=='api':
                arn=API_CANDIDATE;entry['registrationReused']=True
            else:
                a.need(safe['cohortChange']['added']==list(a.TARGETS),'orchestrator planned additions differ')
                entry['status']='REGISTER_INTENT';a.save(output,journal)
                response=aws.call('ecs','register_task_definition',**a.registration_args(current['candidate']))
                arn=response.get('taskDefinition',{}).get('taskDefinitionArn','');helper.validate_new_td_arn(a.SERVICES[name],arn)
            entry['afterTaskDefinition']=arn;entry['status']='REGISTERED';a.save(output,journal)
            a.need(a.digest(helper.task_registration_request(aws.definition(arn)))==safe['candidateHash'],'candidate task definition readback differs')
            a.same_snapshot(a.snapshot(aws,helper,name,plan['proofs'][name]),safe)
            a.need(a.verify_web(aws,plan['proofs']['web-vnext'])==plan['web'],'Web changed immediately before update')
            a.update_once(aws,name,arn,entry,journal,output,safe)
        for name in a.SERVICES:
            safe=plan['services'][name];entry=journal['services'][name]
            value=a.wait_service(aws,helper,name,plan['proofs'][name],entry['afterTaskDefinition'],safe['candidateHash'],safe['desiredCount'],safe['serviceConfigHash'],entry['deploymentId'])
            entry['status']='VERIFIED';entry['readback']=value['safe'];a.save(output,journal)
        journal['status']='VERIFIED';journal['completedAtEpoch']=time.time();journal['receiptHash']=a.digest(journal);a.save(output,journal)
        return journal
    except Exception as error:
        journal['status']='BLOCKED_RECONCILIATION_REQUIRED';journal['errorClass']=type(error).__name__;a.save(output,journal)
        raise

def main():
    spec=importlib.util.spec_from_file_location('adapter',ROOT/'synthetic-canary-codebuild.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
    try:
        a.need(len(sys.argv)==3 and sys.argv[1] in ('--qualify-readonly','--execute-cohort-resume'),'explicit bounded operation required')
        old_plan=a.read_json(ROOT/'synthetic-canary-plan-v3.json');plan=a.read_json(ROOT/'synthetic-canary-plan-v4.json')
        a.need(sys.argv[2]==plan['planHash'],'exact reviewed v4 plan approval required')
        failed_path=ROOT/'synthetic-canary-apply-v3.json';failed=a.read_json(failed_path);qualification=a.read_json(ROOT/'synthetic-canary-qualification.json')
        helper,fullchat=a.load_helpers(REPO);args=(a,a.Aws('default'),helper,fullchat,old_plan,plan,failed,qualification,failed_path.read_bytes(),(ROOT/'synthetic-canary-codebuild-before-namespace.py').read_bytes(),(ROOT/'synthetic-canary-codebuild.py').read_bytes())
        if sys.argv[1]=='--qualify-readonly':
            _,equal=qualify(*args);result={'status':'QUALIFIED_READ_ONLY','planHash':plan['planHash'],'reusedApiTaskDefinition':API_CANDIDATE,'reusedFlagTaskArn':failed['flagJobs'][0]['taskArn'],'comparedEqualPlanFields':equal,'newDatabaseTasks':0,'cloudMutations':0,'observedAtEpoch':time.time()}
            a.create_receipt(ROOT/'synthetic-canary-resume-v4-qualification.json',result)
        else:
            journal=resume(*args,ROOT/'synthetic-canary-apply-v4.json');result={'status':journal['status'],'planHash':plan['planHash'],'receiptHash':journal['receiptHash'],'newDatabaseTasks':0}
        print(json.dumps(result));return 0
    except Exception as error:
        print(json.dumps({'status':'BLOCKED','safeReason':str(error) if isinstance(error,a.Refusal) else type(error).__name__}));return 2

if __name__=='__main__':raise SystemExit(main())
