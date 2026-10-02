import copy,importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import Mock,patch
ROOT=pathlib.Path(__file__).parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
a=load('adapter','synthetic-canary-codebuild.py');r=load('resume','resume-synthetic-canary-cohorts-v4.py')
class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.old=a.read_json(ROOT/'synthetic-canary-plan-v3.json');self.plan=a.read_json(ROOT/'synthetic-canary-plan-v4.json');self.failed=a.read_json(ROOT/'synthetic-canary-apply-v3.json');self.bytes=(ROOT/'synthetic-canary-apply-v3.json').read_bytes();self.qual=a.read_json(ROOT/'synthetic-canary-qualification.json');self.old_source=(ROOT/'synthetic-canary-codebuild-before-namespace.py').read_bytes();self.source=(ROOT/'synthetic-canary-codebuild.py').read_bytes()
    def verify(self):return r.verify_inputs(a,self.old,self.plan,self.failed,self.bytes,self.old_source,self.source)
    def test_exact_saved_failure_and_only_namespace_delta_verified(self):self.assertEqual(set(self.verify()),set(self.old)-r.PLAN_DELTA_FIELDS)
    def test_source_receipt_cannot_be_rewritten(self):
        self.failed['priorStates'][0]['state']={'present':True,'value':False}
        with self.assertRaisesRegex(a.Refusal,'parsed failed receipt'):self.verify()
    def test_new_plan_cannot_change_proof_or_snapshot(self):
        self.plan['services']['api']['desiredCount']=3;self.plan['planHash']=a.digest({k:v for k,v in self.plan.items() if k!='planHash'})
        with self.assertRaisesRegex(a.Refusal,'snapshots changed'):self.verify()
    def test_no_other_adapter_source_change_is_permitted(self):
        self.source+=b'\n# extra\n';self.plan['adapterSha256']=r.hashlib.sha256(self.source).hexdigest();self.plan['planHash']=a.digest({k:v for k,v in self.plan.items() if k!='planHash'})
        with self.assertRaisesRegex(a.Refusal,'not exactly'):self.verify()
    def test_qualify_checks_actual_prior_states_and_true_result(self):
        aws=Mock();helper=Mock();snaps={name:{'safe':safe} for name,safe in self.plan['services'].items()};wrong=copy.deepcopy(self.failed['priorStates']);wrong[0]['state']={'present':True,'value':False}
        with patch.object(a,'verify_plan'),patch.object(a,'qualify_build',side_effect=lambda aws,repo,name,expected:self.plan['proofs'][name]),patch.object(a,'verify_web',return_value=self.plan['web']),patch.object(a,'snapshot',side_effect=lambda aws,helper,name,proof:snaps[name]),patch.object(a,'check_targets'),patch.object(a,'read_flag_result',return_value=(wrong,wrong)):
            with self.assertRaisesRegex(a.Refusal,'completed flag authority'):r.qualify(a,aws,helper,None,self.old,self.plan,self.failed,self.qual,self.bytes,self.old_source,self.source)
        aws.call.assert_not_called()
    def test_resume_reuses_api_and_flag_job_submits_both_updates_before_waiting(self):
        events=[];aws=Mock();helper=Mock();plan=copy.deepcopy(self.plan)
        candidates={name:{'family':name,'tags':[]} for name in a.SERVICES}
        for name in a.SERVICES:plan['services'][name]['candidateHash']=a.digest(candidates[name])
        snaps={name:{'safe':plan['services'][name],'candidate':candidates[name]} for name in a.SERVICES}
        orchard='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meriv2-orchestrator:87'
        def aws_call(namespace,operation,**kwargs):
            events.append(operation);self.assertEqual((namespace,operation),('ecs','register_task_definition'));self.assertEqual(kwargs,{'family':'meriv2-orchestrator'});return {'taskDefinition':{'taskDefinitionArn':orchard}}
        aws.call.side_effect=aws_call;aws.definition.side_effect=lambda arn:{'request':candidates['api' if arn==r.API_CANDIDATE else 'meriv2-orchestrator']};helper.task_registration_request.side_effect=lambda response:response['request']
        def update(aws,name,arn,entry,journal,output,safe):
            events.append('update-'+name);entry.update(status='PROMOTING',deploymentId='owned-'+name);return entry['deploymentId']
        def wait(aws,helper,name,proof,arn,expected_hash,count,config_hash,deployment_id):
            events.append('wait-'+name);self.assertEqual(deployment_id,'owned-'+name);return {'safe':{'taskDefinition':arn}}
        with tempfile.TemporaryDirectory() as tmp,patch.object(r,'qualify',return_value=(snaps,sorted(set(self.old)-r.PLAN_DELTA_FIELDS))),patch.object(a,'claim_operation'),patch.object(a,'snapshot',side_effect=lambda aws,helper,name,proof:snaps[name]),patch.object(a,'check_targets'),patch.object(a,'verify_web',return_value=plan['web']),patch.object(a,'update_once',side_effect=update),patch.object(a,'wait_service',side_effect=wait),patch.object(a,'flag_job',side_effect=AssertionError('DB command must never run')):
            result=r.resume(a,aws,helper,None,self.old,plan,self.failed,self.qual,self.bytes,self.old_source,self.source,pathlib.Path(tmp)/'receipt.json')
        self.assertEqual(events,['update-api','register_task_definition','update-meriv2-orchestrator','wait-api','wait-meriv2-orchestrator']);self.assertEqual(result['status'],'VERIFIED');self.assertEqual(result['flagJobs'],self.failed['flagJobs']);self.assertEqual(result['priorStates'],self.failed['priorStates']);self.assertEqual(result['reconciliation']['newDatabaseTasks'],0);self.assertTrue(result['services']['api']['registrationReused']);self.assertEqual(aws.call.call_count,1)
if __name__=='__main__':unittest.main(verbosity=2)
