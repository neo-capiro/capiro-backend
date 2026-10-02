import copy, hashlib, importlib.util, json, pathlib, tempfile, time, types, unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('canary',ROOT/'synthetic-canary-codebuild.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
REPO = r'C:\dev\cap-meri-fixture-hardening'
h,f = c.load_helpers(REPO)
SHA='a'*40; IMAGE='sha256:'+'b'*64
ARN=f'arn:aws:ecs:{c.REGION}:{c.ACCOUNT}:task-definition/capiro-dev-api:999'
DIAG=f'arn:aws:ecs:{c.REGION}:{c.ACCOUNT}:task-definition/capiro-dev-api-diag:999'
TASK=f'arn:aws:ecs:{c.REGION}:{c.ACCOUNT}:task/{c.CLUSTER}/'+'d'*32

def definition():
    return {'taskDefinition':{'family':'capiro-dev-api','taskRoleArn':'role','executionRoleArn':'exec','networkMode':'awsvpc','requiresCompatibilities':['FARGATE'],'cpu':'256','memory':'512','runtimePlatform':{'cpuArchitecture':'ARM64','operatingSystemFamily':'LINUX'},'containerDefinitions':[{'name':'api','image':'image','environment':[{'name':'MERIV3_ENABLED','value':'true'},{'name':c.ENV,'value':'fixture-existing'},{'name':'DB_NAME','value':'testdb'},{'name':'OTHER','value':'unchanged'}],'secrets':[{'name':name,'valueFrom':'reference-'+name} for name in sorted(f.DB_SECRET_NAMES)],'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-group':'test','awslogs-stream-prefix':'prefix'}}}]},'tags':[]}

def service():
    return {'serviceName':c.SERVICES['api'],'taskDefinition':ARN,'desiredCount':1,'runningCount':1,'pendingCount':0,'unknownFutureConfig':{'preserve':True},'deployments':[{'id':'before-id','status':'PRIMARY','taskDefinition':ARN,'rolloutState':'COMPLETED','desiredCount':1}]}

class CanaryTests(unittest.TestCase):
    def test_union_preserves_existing_bytes_and_only_appends_two(self):
        result,added=c.union_value('fixture-one, fixture-two')
        self.assertEqual(result,'fixture-one, fixture-two,'+','.join(c.TARGETS)); self.assertEqual(added,list(c.TARGETS))
        self.assertEqual(c.union_value(','.join(c.TARGETS)),(','.join(c.TARGETS),[]))
        self.assertEqual(c.union_value(''),(','.join(c.TARGETS),list(c.TARGETS)))

    def test_union_rejects_ambiguous_input(self):
        for raw in ('*','x,x','x,','   ',None):
            with self.subTest(raw=raw), self.assertRaises(c.Refusal): c.union_value(raw)

    def test_transform_only_cohort_and_redacts_customer_names(self):
        original=definition(); candidate,change=c.transform(h,original,'api')
        self.assertNotIn('fixture-existing',c.canonical(change)); self.assertEqual(change['beforeCount'],1); self.assertEqual(change['afterCount'],3)
        self.assertEqual(change['added'],list(c.TARGETS))
        env=candidate['containerDefinitions'][0]['environment']; next(x for x in env if x['name']==c.ENV)['value']='fixture-existing'
        self.assertEqual(candidate,h.task_registration_request(original))

    def test_transform_global_and_duplicate_guards(self):
        for duplicate in (False,True):
            original=definition(); env=original['taskDefinition']['containerDefinitions'][0]['environment']
            if duplicate:env.append(copy.deepcopy(env[1]))
            else:env[0]['value']='false'
            with self.assertRaises(c.Refusal):c.transform(h,original,'api')

    def test_service_fingerprint_retains_unknown_and_excludes_only_volatile(self):
        initial=service(); expected=c.digest(c.service_config(initial)); initial['events']=[{'message':'transient'}]
        initial['runningCount']=0; self.assertEqual(c.digest(c.service_config(initial)),expected)
        initial['unknownFutureConfig']['preserve']=False; self.assertNotEqual(c.digest(c.service_config(initial)),expected)

    def test_rollout_observations_do_not_change_config_hash(self):
        before=service();before.update(currentServiceDeployment='old-deployment-arn',currentServiceRevisions=[{'arn':'old-revision','runningTaskCount':1,'pendingTaskCount':0}])
        expected=c.digest(c.service_config(before));after=copy.deepcopy(before)
        after.update(currentServiceDeployment='new-deployment-arn',currentServiceRevisions=[{'arn':'new-revision','runningTaskCount':0,'pendingTaskCount':1},{'arn':'old-revision','runningTaskCount':1,'pendingTaskCount':0}],runningCount=2,pendingCount=1)
        self.assertEqual(c.digest(c.service_config(after)),expected)
        after['desiredCount']=2;self.assertNotEqual(c.digest(c.service_config(after)),expected)

    def test_wait_accepts_owned_rollout_observations_but_keeps_primary_binding(self):
        before=service();before.update(currentServiceDeployment='old-observation',currentServiceRevisions=[{'arn':'old-revision','runningTaskCount':1}]);config=c.digest(c.service_config(before))
        rolling=copy.deepcopy(before);rolling.update(currentServiceDeployment='new-observation',currentServiceRevisions=[{'arn':'new-revision','runningTaskCount':0}],runningCount=0,pendingCount=1);rolling['deployments'][0]['rolloutState']='IN_PROGRESS'
        final=copy.deepcopy(rolling);final.update(runningCount=1,pendingCount=0,currentServiceRevisions=[{'arn':'new-revision','runningTaskCount':1}]);final['deployments'][0]['rolloutState']='COMPLETED'
        snap={'safe':{'taskDefinition':ARN,'taskDefinitionHash':'hash','desiredCount':1,'serviceConfigHash':config,'primaryDeployment':{'id':'before-id'}}}
        aws=Mock();aws.service.side_effect=[rolling,final]
        with patch.object(c,'snapshot',return_value=snap),patch.object(c,'check_targets'),patch.object(c.time,'sleep') as sleep:
            self.assertIs(c.wait_service(aws,h,'api',{},ARN,'hash',1,config,'before-id'),snap)
        sleep.assert_called_once_with(5)
        final['deployments'][0]['id']='another-deployment';aws.service.side_effect=None;aws.service.return_value=final
        with patch.object(c.time,'sleep') as sleep,self.assertRaisesRegex(c.Refusal,'concurrent'):
            c.wait_service(aws,h,'api',{},ARN,'hash',1,config,'before-id')
        sleep.assert_not_called()

    def test_exact_caller(self):
        aws=c.Aws.__new__(c.Aws); principal=f'arn:aws:iam::{c.ACCOUNT}:user/hermes-cli'
        aws.call=Mock(return_value={'Account':c.ACCOUNT,'Arn':principal}); aws.identity(principal)
        for changed in ({'Account':c.ACCOUNT,'Arn':principal+'-other'},{'Account':'000000000000','Arn':principal}):
            aws.call.return_value=changed
            with self.assertRaises(c.Refusal):aws.identity(principal)

    def test_real_aws_transport_accepts_update_service_named_argument(self):
        client=Mock();client.update_service.return_value={'service':{'taskDefinition':'candidate'}}
        aws=c.Aws.__new__(c.Aws);aws.clients={'ecs':client}
        self.assertEqual(aws.call('ecs','update_service',cluster=c.CLUSTER,service=c.SERVICES['api'],taskDefinition='candidate'),{'service':{'taskDefinition':'candidate'}})
        client.update_service.assert_called_once_with(cluster=c.CLUSTER,service=c.SERVICES['api'],taskDefinition='candidate')

    def test_exclusive_receipt_and_operation_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'receipt.json'; c.create_receipt(path,{'one':1})
            with self.assertRaises(FileExistsError):c.create_receipt(path,{'two':2})
            with patch.object(c,'__file__',str(pathlib.Path(tmp)/'adapter.py')):
                plan={'operationId':'f'*32,'planHash':'hash'}; c.claim_operation(plan,'apply')
                with self.assertRaises(FileExistsError):c.claim_operation(plan,'apply')

    def test_verify_plan_source_clean_and_expiry(self):
        qualification={'fixture':'safe'}; now=time.time()
        def plan():
            value={'schemaVersion':c.SCHEMA,'qualificationHash':c.digest(qualification),'adapterSha256':hashlib.sha256(pathlib.Path(c.__file__).read_bytes()).hexdigest(),'tenants':[list(x) for x in c.TENANTS],'operatorSourceSha':SHA,'createdAtEpoch':now-10,'expiresAtEpoch':now+100}
            return {**value,'planHash':c.digest(value)}
        with patch.object(c,'git',side_effect=[SHA.encode(),b'']):c.verify_plan(plan(),qualification,REPO)
        with patch.object(c,'git',side_effect=[SHA.encode(),b' M changed']):
            with self.assertRaisesRegex(c.Refusal,'checkout changed'):c.verify_plan(plan(),qualification,REPO)
        value=plan(); value['expiresAtEpoch']=now-1; value['planHash']=c.digest({k:v for k,v in value.items() if k!='planHash'})
        with patch.object(c,'git',side_effect=[SHA.encode(),b'']):
            with self.assertRaisesRegex(c.Refusal,'expired'):c.verify_plan(value,qualification,REPO)
        with patch.object(c,'git',side_effect=[SHA.encode(),b'']):c.verify_plan(value,qualification,REPO,rollback=True)

    def test_update_writes_intent_before_fresh_drift_read_and_binds_id(self):
        before=service(); after=copy.deepcopy(before); after['taskDefinition']='candidate'; after['deployments'][0].update(id='actual-new-id',taskDefinition='candidate',rolloutState='IN_PROGRESS')
        journal={'services':{}}; entry={}; events=[]
        aws=Mock(); aws.service.side_effect=lambda _:events.append('fresh-read') or before; aws.call.return_value={'service':after}
        expected={'serviceConfigHash':c.digest(c.service_config(before)),'taskDefinition':ARN,'primaryDeployment':c.primary_state(before)}
        with patch.object(c,'save',side_effect=lambda *_:events.append('saved')):
            self.assertEqual(c.update_once(aws,'api','candidate',entry,journal,'unused',expected),'actual-new-id')
        self.assertEqual(events[:2],['saved','fresh-read']); self.assertEqual(entry['deploymentId'],'actual-new-id'); aws.call.assert_called_once()

    def test_update_rejects_config_and_same_td_primary_drift_without_write(self):
        before=service(); expected={'serviceConfigHash':c.digest(c.service_config(before)),'taskDefinition':ARN,'primaryDeployment':c.primary_state(before)}
        for field in ('config','primary'):
            changed=copy.deepcopy(before)
            if field=='config':changed['unknownFutureConfig']['preserve']=False
            else:changed['deployments'][0]['id']='concurrent'
            aws=Mock();aws.service.return_value=changed;entry={}
            with patch.object(c,'save'),self.assertRaises(c.Refusal):c.update_once(aws,'api','candidate',entry,{},'unused',expected)
            self.assertEqual(entry['status'],'UPDATE_INTENT');aws.call.assert_not_called()

    def test_uncertain_update_not_retried(self):
        before=service();aws=Mock();aws.service.return_value=before;aws.call.side_effect=c.Refusal('unknown ack');entry={}
        expected={'serviceConfigHash':c.digest(c.service_config(before)),'taskDefinition':ARN,'primaryDeployment':c.primary_state(before)}
        with patch.object(c,'save'),self.assertRaises(c.Refusal):c.update_once(aws,'api','candidate',entry,{},'unused',expected)
        aws.call.assert_called_once();self.assertEqual(entry['status'],'UPDATE_INTENT')

    def test_wait_rejects_concurrent_primary_immediately(self):
        before=service();aws=Mock();aws.service.return_value=before
        with patch.object(c.time,'sleep') as sleep,self.assertRaisesRegex(c.Refusal,'concurrent'):
            c.wait_service(aws,h,'api',{},ARN,'unused',1,c.digest(c.service_config(before)),'different-id')
        sleep.assert_not_called()

    def test_wait_returns_only_verified_exact_deployment(self):
        before=service();aws=Mock();aws.service.return_value=before;config=c.digest(c.service_config(before))
        snap={'safe':{'taskDefinition':ARN,'taskDefinitionHash':'hash','desiredCount':1,'serviceConfigHash':config,'primaryDeployment':{'id':'before-id'}}}
        with patch.object(c,'snapshot',return_value=snap),patch.object(c,'check_targets') as health:
            self.assertIs(c.wait_service(aws,h,'api',{},ARN,'hash',1,config,'before-id'),snap)
        health.assert_called_once()

    def test_target_health_requires_actual_task_ip_and_port(self):
        snap={'tasks':[{'attachments':[{'details':[{'name':'privateIPv4Address','value':'127.0.0.2'}]}]}],'service':{'loadBalancers':[{'containerName':'api','containerPort':3000,'targetGroupArn':'test'}]},'containerName':'api'}
        aws=Mock();aws.call.return_value={'TargetHealthDescriptions':[{'Target':{'Id':'127.0.0.2','Port':3000},'TargetHealth':{'State':'healthy'}}]};c.check_targets(aws,snap)
        for key,value in (('Id','127.0.0.3'),('Port',3001)):
            changed=copy.deepcopy(aws.call.return_value);changed['TargetHealthDescriptions'][0]['Target'][key]=value
            aws.call.return_value=changed
            with self.assertRaises(c.Refusal):c.check_targets(aws,snap)

    def test_diagnostic_defaults_only_normalized(self):
        request={'containerDefinitions':[{'name':'db-inspect'}]};actual=copy.deepcopy(request)
        actual.update(volumes=[],placementConstraints=[],tags=[]);actual['containerDefinitions'][0].update(cpu=0,portMappings=[],mountPoints=[],volumesFrom=[],systemControls=[])
        self.assertEqual(c.diagnostic_projection(actual),c.diagnostic_projection(request))
        actual['containerDefinitions'][0]['cpu']=1;self.assertNotEqual(c.diagnostic_projection(actual),c.diagnostic_projection(request))

    def test_registration_omits_only_empty_tags_preserves_nonempty_and_input(self):
        request={'family':'test','tags':[],'containerDefinitions':[{'name':'test'}]}
        actual=c.registration_args(request);self.assertNotIn('tags',actual);self.assertEqual(request['tags'],[])
        self.assertEqual(actual,{k:v for k,v in request.items() if k!='tags'})
        request['tags']=[{'key':'fixture','value':'owned'}];self.assertEqual(c.registration_args(request),request)

    def test_web_proof_binds_actual_balancer_container_not_sidecar(self):
        svc=service();svc.update(serviceArn=f'arn:aws:ecs:{c.REGION}:{c.ACCOUNT}:service/{c.CLUSTER}/capiro-dev-web-vnext',clusterArn=f'arn:aws:ecs:{c.REGION}:{c.ACCOUNT}:cluster/{c.CLUSTER}',loadBalancers=[{'containerName':'actual-web','containerPort':3000,'targetGroupArn':'target'}])
        aws=Mock();aws.service.return_value=svc;aws.task_arns.return_value=[TASK]
        aws.definition.return_value={'taskDefinition':{'taskDefinitionArn':ARN,'containerDefinitions':[{'name':'actual-web','image':'qualified'}]}}
        task={'taskArn':TASK,'clusterArn':svc['clusterArn'],'taskDefinitionArn':ARN,'lastStatus':'RUNNING','desiredStatus':'RUNNING','containers':[{'name':'actual-web','imageDigest':IMAGE}]};aws.tasks.return_value=[task]
        with patch.object(c,'check_targets') as health:c.verify_web(aws,{'image':'qualified','imageDigest':IMAGE})
        health.assert_called_once();self.assertEqual(health.call_args.args[1]['containerName'],'actual-web')
        task['containers']=[{'name':'actual-web','imageDigest':'old'},{'name':'sidecar','imageDigest':IMAGE}]
        with patch.object(c,'check_targets'),self.assertRaisesRegex(c.Refusal,'application not served'):c.verify_web(aws,{'image':'qualified','imageDigest':IMAGE})

    def flag_fixture(self,mode='plan'):
        original=definition();snap={'response':original,'container':original['taskDefinition']['containerDefinitions'][0]};proof={'sourceSha':SHA,'imageDigest':IMAGE,'image':'image'};plan={'proofs':{'api':proof}}
        request=c.diagnostic_request(h,f,snap,proof);response={'taskDefinition':{**request,'taskDefinitionArn':DIAG}}
        before=[{'tenantId':i,'tenantSlug':s,'flag':f.FLAG,'state':{'present':False}} for i,s in c.TENANTS]
        result={'schemaVersion':1,'operation':'meri-foundation-fullchat','mode':mode,'result':'PLAN_ONLY' if mode=='plan' else 'APPLIED_AND_VERIFIED','flag':f.FLAG,'tenants':[{'tenantId':i,'tenantSlug':s,'before':{'present':False},'after':{'present':False} if mode=='plan' else {'present':True,'value':True}} for i,s in c.TENANTS]}
        expected=None if mode=='plan' else before
        task={'taskArn':TASK,'taskDefinitionArn':DIAG,'clusterArn':f'arn:aws:ecs:{c.REGION}:{c.ACCOUNT}:cluster/{c.CLUSTER}','lastStatus':'STOPPED','containers':[{'name':f.CONTAINER,'lastStatus':'STOPPED','exitCode':0,'imageDigest':IMAGE}],'overrides':{'containerOverrides':[{'name':f.CONTAINER,'command':f.command_for(mode,expected),'environment':[],'resourceRequirements':[]}]}}
        job={'mode':mode,'status':'VERIFIED','taskArn':TASK,'taskDefinition':DIAG,'requestHash':c.digest(c.diagnostic_projection(request)),'result':result}
        aws=Mock();aws.definition.return_value=response;aws.tasks.return_value=[task];aws.logs.return_value=[f.RESULT_PREFIX+json.dumps(result)]
        return aws,plan,snap,job,expected,before

    def test_flag_authority_real_parser_and_default_overrides(self):
        for mode in ('plan','apply'):
            aws,plan,snap,job,expected,before=self.flag_fixture(mode)
            actual,_=c.read_flag_result(aws,h,f,plan,snap,job,mode,expected);self.assertEqual(actual,before)

    def test_flag_authority_accepts_only_empty_inference_accelerator_observation(self):
        aws,plan,snap,job,expected,before=self.flag_fixture();aws.tasks.return_value[0]['overrides']['inferenceAcceleratorOverrides']=[]
        actual,_=c.read_flag_result(aws,h,f,plan,snap,job,'plan',expected);self.assertEqual(actual,before)
        for extra in ({'inferenceAcceleratorOverrides':[{'deviceName':'device','deviceType':'type'}]},{'inferenceAcceleratorOverrides':None},{'unknownOverride':[]}):
            aws,plan,snap,job,expected,_=self.flag_fixture();aws.tasks.return_value[0]['overrides'].update(extra)
            with self.subTest(extra=extra),self.assertRaisesRegex(c.Refusal,'command/roles/environment'):
                c.read_flag_result(aws,h,f,plan,snap,job,'plan',expected)

    def test_flag_authority_rejects_exit_digest_command_role_and_saved_result_tampering(self):
        for change in ('exit','digest','command','role','result','definition'):
            aws,plan,snap,job,expected,_=self.flag_fixture();task=aws.tasks.return_value[0]
            if change=='exit':task['containers'][0]['exitCode']=1
            elif change=='digest':task['containers'][0]['imageDigest']='sha256:'+'c'*64
            elif change=='command':task['overrides']['containerOverrides'][0]['command']=['sh','-c','echo fake']
            elif change=='role':task['overrides']['taskRoleArn']='another-role'
            elif change=='result':job['result']['tenants'][0]['before']={'present':True,'value':False}
            else:aws.definition.return_value['taskDefinition']['taskRoleArn']='another-role'
            with self.subTest(change=change),self.assertRaises(c.Refusal):c.read_flag_result(aws,h,f,plan,snap,job,'plan',expected)

    def test_rollback_cannot_use_modified_prior_state_in_actual_apply_command(self):
        aws,plan,snap,job,expected,_=self.flag_fixture('apply');modified=copy.deepcopy(expected);modified[0]['state']={'present':True,'value':False}
        with self.assertRaisesRegex(c.Refusal,'command/roles/environment'):c.read_flag_result(aws,h,f,plan,snap,job,'apply',modified)

    def test_codebuild_capture_source_callback_preserves_original_function(self):
        calls=[]
        def original(bridge, git_port):
            validate_image_source(git_port,bridge)
            return {'runtimeGuardsExecuted':True}
        original=types.FunctionType(original.__code__,{'validate_image_source':lambda *_:(_ for _ in ()).throw(RuntimeError('legacy Actions lineage'))})
        fake=types.SimpleNamespace(capture_runtime=original,FLAG=f.FLAG)
        def git_fake(repo,*args):
            calls.append(args)
            if args[0]=='show':return b'--foundation-fullchat '+f.FLAG.encode()+b' set-tenant-flag)'
            return b''
        with patch.object(c,'git',side_effect=git_fake):
            self.assertEqual(c.capture_codebuild_runtime(SHA,fake,REPO,{'sourceSha':SHA}),{'runtimeGuardsExecuted':True})
        self.assertNotIn(('merge-base','--is-ancestor',f.API_IMAGE_PRODUCER_COMMIT,SHA),calls)
        with self.assertRaises(RuntimeError):original(SHA,None)

    def test_codebuild_qualification_requires_actual_source_recipe_digest_and_runtime_proofs(self):
        with tempfile.TemporaryDirectory() as tmp:
            recipe=pathlib.Path(tmp)/'buildspec.yml';recipe.write_text('version: 0.2\n')
            expected={'sourceSha':SHA,'imageDigest':IMAGE,'buildId':c.PROJECT+':fixed','buildspecPath':str(recipe),'buildspecSha256LF':hashlib.sha256(recipe.read_text().encode()).hexdigest()}
            build={'id':expected['buildId'],'projectName':c.PROJECT,'buildStatus':'SUCCEEDED','sourceVersion':SHA,'resolvedSourceVersion':SHA,'source':{'type':'GITHUB','location':c.REPOSITORY,'buildspec':recipe.read_text()},'environment':{'type':'ARM_CONTAINER'},'logs':{'groupName':'group','streamName':'stream'}}
            lines=['CANDIDATE_API_IMAGE='+c.REGISTRY+'/capiro/dev/api@'+IMAGE,'CANDIDATE_API_SOURCE_SHA='+SHA,'LOCAL_REPODIGEST_ECR_MATCH_PASS','OFFLINE_RUNTIME_IMPORT_PASS','EXACT_449_IMAGE_MIGRATION_HASHES_PASS']
            for change in ('valid','status','source','repository','recipe','digest','runtime-proof'):
                current=copy.deepcopy(build);current_lines=list(lines);details={'imageDigest':IMAGE,'imageTags':[SHA]}
                if change=='status':current['buildStatus']='FAILED'
                elif change=='source':current['resolvedSourceVersion']='c'*40
                elif change=='repository':current['source']['location']='https://github.com/other/repo'
                elif change=='recipe':current['source']['buildspec']='unreviewed'
                elif change=='digest':details['imageDigest']='sha256:'+'c'*64
                elif change=='runtime-proof':current_lines.remove('OFFLINE_RUNTIME_IMPORT_PASS')
                aws=Mock();aws.logs.return_value=current_lines
                aws.call.side_effect=lambda svc,op,**kw: {'builds':[current]} if svc=='codebuild' else {'imageDetails':[details]}
                with self.subTest(change=change),patch.object(c,'git',return_value=b'identical-owner'):
                    if change=='valid':self.assertEqual(c.qualify_build(aws,REPO,'api',expected)['provider'],'AWS_CODEBUILD')
                    else:
                        with self.assertRaises(c.Refusal):c.qualify_build(aws,REPO,'api',expected)

if __name__=='__main__':unittest.main(verbosity=2)
