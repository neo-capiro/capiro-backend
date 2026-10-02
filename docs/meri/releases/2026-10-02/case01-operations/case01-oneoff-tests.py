import copy, importlib.util, json, pathlib, tempfile, unittest, types
from unittest.mock import patch

PATH=pathlib.Path(__file__).with_name('case01-oneoff.py')
spec=importlib.util.spec_from_file_location('operator_case01',PATH)
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a=m.adapter()
SOURCE='a'*40; DIGEST='sha256:'+'b'*64
IMAGE=f'{a.REGISTRY}/capiro/dev/api@{DIGEST}'
TD=f'arn:aws:ecs:{m.REGION}:{m.ACCOUNT}:task-definition/{m.FAMILY}:1'
TASK=f'arn:aws:ecs:{m.REGION}:{m.ACCOUNT}:task/{m.CLUSTER}/'+'c'*32
PROOF={'sourceSha':SOURCE,'operatorHead':SOURCE,'imageDigest':DIGEST,'image':IMAGE}

def snap():
    env={'DB_NAME':'capiro_dev','GIT_SHA':SOURCE,'RELEASE_SHA':SOURCE,
      'MEMORY_GOVERNANCE_TENANTS':m.T1+','+m.T2,
      'MERI_SYNTHETIC_FIXTURE_NAMESPACE':m.NAMESPACE,
      'EMBEDDINGS_MODEL':'amazon.titan-embed-text-v2:0',
      **{key:'enforce' for key in m.FLAGS},'UNRELATED':'must not propagate'}
    api={'environment':[{'name':key,'value':value} for key,value in env.items()],
      'secrets':[{'name':key,'valueFrom':f'arn:aws:secretsmanager:{m.REGION}:{m.ACCOUNT}:secret:fixture/{key}'} for key in sorted(m.DB_REFS|{'OPENAI_API_KEY','UNRELATED_CREDENTIAL'})],
      'logConfiguration':{'logDriver':'awslogs','options':{'awslogs-region':m.REGION,'awslogs-group':'/ecs/capiro-dev-api','awslogs-stream-prefix':'ecs'}}}
    definition={'taskRoleArn':f'arn:aws:iam::{m.ACCOUNT}:role/runtime','executionRoleArn':f'arn:aws:iam::{m.ACCOUNT}:role/execution',
      'networkMode':'awsvpc','requiresCompatibilities':['FARGATE'],'cpu':'1024','memory':'2048','runtimePlatform':{'cpuArchitecture':'ARM64','operatingSystemFamily':'LINUX'}}
    return {'container':api,'definition':definition,'safe':{'taskDefinition':'approved-current','taskDefinitionHash':'1','serviceConfigHash':'2','primaryDeploymentId':'ecs-owned','runningTaskArns':['current-task']},
      'service':{'networkConfiguration':{'awsvpcConfiguration':{'subnets':['subnet-owned'],'securityGroups':['sg-owned'],'assignPublicIp':'DISABLED'}},'platformVersion':'1.4.0'}}

def owner_plan(): return {'kind':'meri-case01-execution-setup-plan','planSha256':'d'*64,'liveAcceptance':'NOT_RUN'}
class Helper:
    def task_registration_request(self,response): return response['taskDefinition']

class FakeAws:
    def __init__(self): self.definition_request=None; self.calls=[]; self.run_error=False; self.exit=0; self.logs_override=None; self.overrides=None
    def identity(self,caller): self.calls.append(('identity',caller)); assert caller==m.CALLER
    def definition(self,arn): return {'taskDefinition':self.definition_request}
    def task_arns(self,**args): return []
    def tasks(self,arns):
        return [{'taskArn':TASK,'clusterArn':f'arn:aws:ecs:{m.REGION}:{m.ACCOUNT}:cluster/{m.CLUSTER}',
          'taskDefinitionArn':TD,'lastStatus':'STOPPED','overrides':dict(self.overrides,inferenceAcceleratorOverrides=[]),
          'containers':[{'name':m.CONTAINER,'imageDigest':DIGEST,'lastStatus':'STOPPED','exitCode':self.exit}]}]
    def logs(self,group,stream):
        assert stream.endswith(TASK.rsplit('/',1)[1])
        return self.logs_override if self.logs_override is not None else ['raw customer/provider log ignored',m.PREFIX['setup']+json.dumps(owner_plan())]
    def call(self,namespace,operation,**kwargs):
        self.calls.append((namespace,operation))
        if operation=='register_task_definition':
            self.definition_request=copy.deepcopy(kwargs)
            return {'taskDefinition':{'taskDefinitionArn':TD}}
        if operation=='run_task':
            self.overrides=copy.deepcopy(kwargs['overrides'])
            if self.run_error: raise RuntimeError('private transport detail')
            return {'tasks':[{'taskArn':TASK}]}
        raise AssertionError('Unexpected AWS operation')

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='case01-operator-test-',dir=PATH.parent)
        self.root=pathlib.Path(self.temp.name).resolve()
        self.assertEqual(self.root.parent,PATH.parent.resolve())
        self.scope=patch.object(m,'ROOT',self.root); self.scope.start()
        self.input=self.root/'input.json'
        self.input.write_text(json.dumps({'recipe':{'ctx':{'tenantId':m.T1,'tenantSlug':m.NAMESPACE+'-t1','userId':'44444444-4444-4444-8444-444444444444','role':'standard_user'}}}))
    def tearDown(self):
        self.scope.stop(); self.assertEqual(self.root.parent,PATH.parent.resolve()); self.temp.cleanup()
    def args(self): return types.SimpleNamespace(repo='not-used',proof='not-used',proof_sha256='f'*64,input=str(self.input),input_sha256=m.file_sha(self.input),mode='setup-plan',out=str(self.root/'plan.json'))
    def prepared(self,aws=None):
        args=self.args(); aws=aws or FakeAws()
        with patch.object(m,'qualify',return_value=PROOF),patch.object(m,'snapshot',return_value=snap()):
            m.prepare(a,Helper(),aws,args)
        plan=m.read_json(args.out); args.plan=args.out; args.plan_sha256=plan['planHash']; args.out=str(self.root/'run.json'); args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
        return args,aws,plan
    def run_fake(self,args,aws):
        with patch.object(m,'qualify',return_value=PROOF),patch.object(m,'source_check',return_value=SOURCE),patch.object(m,'snapshot',return_value=snap()):
            return m.run(a,Helper(),aws,args)
    def git_source(self,head=SOURCE,main=None,ancestor=SOURCE,paths=b'docs/receipt.json\0',dirty=b''):
        def git(repo,*args):
            if args==('rev-parse','HEAD'): return head.encode()
            if args==('rev-parse','origin/main'): return (main or head).encode()
            if args[0]=='status': return dirty
            if args[0]=='remote': return b'https://github.com/neo-capiro/capirov2.git'
            if args[0]=='merge-base': return ancestor.encode()
            if args[0]=='diff':
                self.assertEqual(args,('diff','--name-only','--no-renames','-z',SOURCE,head)); return paths
            if args[0]=='show': return b'meri-case01-setup)\n shift\n compose_database_url\n exec node scripts/meri-case01-setup.mjs\nmeri-capture-provider-budget)\n shift\n compose_database_url\n exec node scripts/meri-capture-provider-budget.mjs'
            raise AssertionError(args)
        return types.SimpleNamespace(git=git)
    def test_definition_environment_order_is_semantic_only(self):
        original=m.task_request(a,snap(),PROOF,'setup-plan')
        reordered=copy.deepcopy(original)
        reordered['containerDefinitions'][0]['environment'].reverse()
        self.assertEqual(m.definition_projection(a,original),m.definition_projection(a,reordered))
        for mutation in [lambda e:e.pop(),lambda e:e.append({'name':'EXTRA','value':'new'}),lambda e:e[0].update(value='changed')]:
            changed=copy.deepcopy(original);mutation(changed['containerDefinitions'][0]['environment'])
            self.assertNotEqual(m.definition_projection(a,original),m.definition_projection(a,changed))
    def test_definition_environment_rejects_ambiguous_entries(self):
        original=m.task_request(a,snap(),PROOF,'setup-plan')
        for entries in [None,{},[{'name':'','value':'v'}],[{'name':'N','value':1}],[{'name':'N','value':'v'},{'name':'N','value':'v'}]]:
            changed=copy.deepcopy(original);changed['containerDefinitions'][0]['environment']=entries
            with self.assertRaises(m.Refusal):m.definition_projection(a,changed)
    def test_definition_preserves_commands_secrets_and_unknown_fields(self):
        original=m.task_request(a,snap(),PROOF,'setup-plan')
        for key,value in [('command',['changed']),('secrets',[]),('unknownMeaningfulField',True)]:
            changed=copy.deepcopy(original);changed['containerDefinitions'][0][key]=value
            self.assertNotEqual(m.definition_projection(a,original),m.definition_projection(a,changed))
    def test_registered_environment_reorder_allows_actual_guarded_flow(self):
        args,aws,plan=self.prepared()
        def read_definition(arn):
            result=copy.deepcopy(aws.definition_request)
            result['containerDefinitions'][0]['environment'].reverse()
            return {'taskDefinition':result}
        aws.definition=read_definition
        result=self.run_fake(args,aws)
        self.assertEqual(result['status'],'VERIFIED')
        self.assertEqual(aws.calls.count(('ecs','run_task')),1)
    def test_source_only_exact_main_or_docs_only_descendant(self):
        self.assertEqual(m.source_check(self.git_source(),'unused',SOURCE),SOURCE)
        head='c'*40
        self.assertEqual(m.source_check(self.git_source(head),'unused',SOURCE),head)
        for fake in [self.git_source(head,main=SOURCE),self.git_source(head,ancestor='d'*40),self.git_source(head,paths=b'docs/receipt.json\0apps/api/scripts/entrypoint.sh\0'),self.git_source(head,paths=b'scripts/meri-synthetic-fullchat.py\0'),self.git_source(head,dirty=b'?? docs/unreviewed.json')]:
            with self.assertRaises(m.Refusal): m.source_check(fake,'unused',SOURCE)
    def test_operator_head_drift_refuses_before_registration(self):
        args,aws,plan=self.prepared()
        with patch.object(m,'qualify',return_value=dict(PROOF,operatorHead='d'*40)):
            with self.assertRaises(m.Refusal): m.run(a,Helper(),aws,args)
        self.assertEqual(m.read_json(args.out)['code'],'OPERATOR_MAIN_DRIFT')
        self.assertNotIn(('ecs','register_task_definition'),aws.calls)
    def test_fixed_input_command_and_size(self):
        args=self.args(); _,overrides=m.input_binding(args.mode,args.input,args.input_sha256)
        row=overrides['containerOverrides'][0]
        self.assertEqual(row['command'],['meri-case01-setup','plan','--input-env','MERI_CASE01_SETUP_INPUT','--out','/dev/shm/meri-case01-owner-receipt.jsonl'])
        value=json.loads(self.input.read_text()); value['padding']='x'*2001; self.input.write_text(json.dumps(value))
        with self.assertRaises(m.Refusal): m.input_binding(args.mode,self.input,m.file_sha(self.input))
    def test_hash_actor_and_sensitive_input_refused(self):
        with self.assertRaises(m.Refusal): m.input_binding('setup-plan',self.input,'0'*64)
        value=json.loads(self.input.read_text()); value['recipe']['ctx']['tenantId']=m.T2; self.input.write_text(json.dumps(value))
        with self.assertRaises(m.Refusal): m.input_binding('setup-plan',self.input,m.file_sha(self.input))
        value['password']='must-never-print'; self.input.write_text(json.dumps(value))
        with self.assertRaises(m.Refusal): m.input_binding('setup-plan',self.input,m.file_sha(self.input))
    def test_minimal_task_has_real_roles_image_and_only_exact_secret_refs(self):
        original=snap(); before=copy.deepcopy(original)
        plan=m.task_request(a,original,PROOF,'setup-plan')
        execute=m.task_request(a,original,PROOF,'setup-execute')
        self.assertEqual(original,before)
        self.assertEqual(plan['taskRoleArn'],original['definition']['taskRoleArn'])
        self.assertEqual(plan['executionRoleArn'],original['definition']['executionRoleArn'])
        self.assertEqual(plan['containerDefinitions'][0]['image'],IMAGE)
        self.assertEqual({x['name'] for x in plan['containerDefinitions'][0]['secrets']},m.DB_REFS)
        self.assertEqual({x['name'] for x in execute['containerDefinitions'][0]['secrets']},m.DB_REFS|{'OPENAI_API_KEY'})
        self.assertNotIn('UNRELATED',{x['name'] for x in plan['containerDefinitions'][0]['environment']})
    def test_control_shadow_environmentfiles_model_shadow_refused(self):
        for change in [lambda x:x['container'].update(environmentFiles=[{'value':'opaque'}]),
          lambda x:x['container']['secrets'].append({'name':'MEMORY_GOVERNANCE_ENFORCE','valueFrom':'secret'}),
          lambda x:x['container']['environment'].append({'name':'DB_USER','value':'shadow'}),
          lambda x:x['container']['environment'].append({'name':'OPENAI_API_KEY','value':'plaintext'})]:
            s=snap(); change(s)
            with self.assertRaises(m.Refusal): m.task_request(a,s,PROOF,'setup-execute')
    def test_receipt_filters_raw_logs_and_preserves_partial_without_green(self):
        good=m.PREFIX['setup']+json.dumps(owner_plan())
        self.assertEqual(m.owner_receipts(['raw log',good],'setup-plan'),[owner_plan()])
        partial={'stage':'CURRENT_SEED','phase':'INTENT','captureRunId':'d'*36}
        line=m.PREFIX['setup']+json.dumps(partial)
        self.assertEqual(m.owner_receipts([line],'setup-execute',False),[partial])
        with self.assertRaises(m.Refusal): m.owner_receipts([line],'setup-execute')
        with self.assertRaises(m.Refusal): m.owner_receipts([m.PREFIX['setup']+'{"password":"private"}'],'setup-plan',False)
    def test_task_binding_only_known_empty_default_tolerated(self):
        _,expected=m.input_binding('setup-plan',self.input,m.file_sha(self.input)); aws=FakeAws(); aws.overrides=expected
        task=aws.tasks([TASK])[0]; m.task_identity(task,TASK,TD,expected,DIGEST)
        task['overrides']['taskRoleArn']='foreign'
        with self.assertRaises(m.Refusal): m.task_identity(task,TASK,TD,expected,DIGEST)
        task=aws.tasks([TASK])[0]; task['containers'][0]['imageDigest']='sha256:'+'0'*64
        with self.assertRaises(m.Refusal): m.task_identity(task,TASK,TD,expected,DIGEST)
    def test_success_one_run_exact_exit_and_no_raw_logs(self):
        args,aws,_=self.prepared(); result=self.run_fake(args,aws)
        self.assertEqual(result['status'],'VERIFIED')
        receipt=m.read_json(args.out)
        self.assertEqual(receipt['containerExitCode'],0)
        self.assertEqual(receipt['ownerReceipts'],[owner_plan()])
        self.assertNotIn('raw customer',pathlib.Path(args.out).read_text())
        self.assertEqual(aws.calls.count(('ecs','run_task')),1)
    def test_unknown_ack_is_journaled_and_second_run_never_resubmits(self):
        args,aws,_=self.prepared(); aws.run_error=True
        with self.assertRaises(m.Refusal): self.run_fake(args,aws)
        receipt=m.read_json(args.out)
        self.assertEqual(receipt['status'],'RECONCILIATION_REQUIRED')
        self.assertIn('startedBy',receipt)
        self.assertNotIn('private transport',pathlib.Path(args.out).read_text())
        with self.assertRaises(FileExistsError): self.run_fake(args,aws)
        self.assertEqual(aws.calls.count(('ecs','run_task')),1)
    def test_tampered_plan_and_drift_refuse_before_registration(self):
        args,aws,plan=self.prepared(); plan['baseline']['primaryDeploymentId']='other'
        pathlib.Path(args.plan).write_text(json.dumps(plan))
        with self.assertRaises(m.Refusal): self.run_fake(args,aws)
        self.assertNotIn(('ecs','register_task_definition'),aws.calls)
    def test_nonzero_exit_never_green(self):
        args,aws,_=self.prepared(); aws.exit=1
        with self.assertRaises(m.Refusal): self.run_fake(args,aws)
        receipt=m.read_json(args.out)
        self.assertEqual(receipt['containerExitCode'],1)
        self.assertEqual(receipt['status'],'RECONCILIATION_REQUIRED')
        self.assertEqual(receipt['ownerReceipts'],[owner_plan()])

if __name__=='__main__': unittest.main()
