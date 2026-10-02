import copy, importlib.util, json, pathlib, tempfile, types, unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
r = load('recovery_wrapper', 'case01-recovery-oneoff.py')
b = load('base_tests', 'case01-oneoff-tests.py')
a = b.a

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='case01-recovery-test-', dir=ROOT)
        self.root = pathlib.Path(self.temp.name)
        self.inputs = {mode: self.root / ('input-' + mode + '.json') for mode in r.INPUTS}
        self.plans = {mode: self.root / ('plan-' + mode + '.json') for mode in r.INPUTS}
        self.executions = {mode: self.root / ('execution-' + mode + '.json') for mode in r.INPUTS}
        self.patchers = [patch.object(r, 'INPUTS', self.inputs), patch.object(r, 'TASK_PLANS', self.plans), patch.object(r, 'EXECUTIONS', self.executions)]
        for p in self.patchers: p.start()
        self.m = r.load_operator(r.PLAN_MODE); self.m.ROOT = self.root
        self.m.create(self.inputs[r.PLAN_MODE], self.m.fixed_inputs())
    def tearDown(self):
        for p in reversed(self.patchers): p.stop()
        self.temp.cleanup()
    def plan(self):
        m = self.m; base = m.fixed_inputs()
        body = dict(kind='meri-case01-first-approval-recovery-plan', schemaVersion=1, recoveryMode='FIRST_APPROVAL_PENDING',
            recipeSha256=m.digest(base['recipe']), captureRunId=r.RUN, originalClaimSha256=base['expected']['originalClaimSha256'],
            candidateId=r.CANDIDATE, candidateRowVersion=r.VERSION, candidatePayloadSha256='d'*64,
            previousManifestSha256='e'*64, currentManifestSha256='f'*64, tenantRowVersion='456', priorSettingsSha256='1'*64, liveAcceptance='NOT_RUN')
        return dict(body, planSha256=m.digest(body))
    def args(self, mode=r.PLAN_MODE):
        return types.SimpleNamespace(repo='unused', proof='unused', proof_sha256='f'*64,
            input=str(self.inputs[mode]), input_sha256=self.m.file_sha(self.inputs[mode]), mode=mode, out=str(self.plans[mode]))
    def prepared(self):
        m = self.m; args = self.args(); aws = b.FakeAws()
        aws.logs_override = [m.PREFIX['setup'] + json.dumps(self.plan())]
        with patch.object(m,'qualify',return_value=b.PROOF), patch.object(m,'snapshot',return_value=b.snap()):
            m.prepare(a,b.Helper(),aws,args)
        plan = m.read_json(args.out)
        args.plan=args.out; args.plan_sha256=plan['planHash']; args.out=str(self.executions[r.PLAN_MODE]); args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
        return args,aws,plan
    def run_fake(self,args,aws):
        with patch.object(self.m,'qualify',return_value=b.PROOF),patch.object(self.m,'source_check',return_value=b.SOURCE),patch.object(self.m,'snapshot',return_value=b.snap()):
            return self.m.run(a,b.Helper(),aws,args)
    def source_git(self, altered=False):
        entrypoint=b'meri-case01-setup)\n shift\n compose_database_url\n exec node scripts/meri-case01-setup.mjs\nmeri-capture-provider-budget)\n shift\n compose_database_url\n exec node scripts/meri-capture-provider-budget.mjs'
        def git(repo,*args):
            if args[0]=='rev-parse': return b.SOURCE.encode()
            if args[0]=='status': return b''
            if args[0]=='remote': return b'https://github.com/neo-capiro/capirov2.git'
            if args[0]=='show':
                path=args[1].split(':',1)[1]
                if path=='apps/api/scripts/entrypoint.sh':return entrypoint
                data=(pathlib.Path('C:/dev/cap-meri-doc-fidelity')/path).read_bytes()
                return data+b'\n# drift' if altered else data
            raise AssertionError(args)
        return git
    def qualification(self):
        args,aws,_=self.prepared();self.run_fake(args,aws)
        value=self.m.fixed_inputs();value.update(expectedPlanSha256=self.plan()['planSha256'],ownerPlanExecutionSha256=self.m.file_sha(args.out))
        self.m.create(self.inputs[r.EXECUTE_MODE],value)
        m=r.load_operator(r.EXECUTE_MODE);m.ROOT=self.root
        proof=self.root/'proof.json';proof.write_text(json.dumps(dict(b.PROOF,buildId='reviewed-build')))
        oldcall,oldlogs=aws.call,aws.logs
        def call(namespace,operation,**kw):
            if (namespace,operation)==('codebuild','batch_get_builds'):
                aws.calls.append((namespace,operation));return {'builds':[{'logs':{'groupName':'build','streamName':'build-stream'}}]}
            return oldcall(namespace,operation,**kw)
        aws.call=call
        aws.logs=lambda group,stream:['OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS'] if group=='build' else oldlogs(group,stream)
        def check():
            with patch.object(a,'git',side_effect=self.source_git()),patch.object(a,'qualify_build',return_value=dict(b.PROOF,buildId='reviewed-build')),patch.object(a,'load_helpers',return_value=(b.Helper(),None)):
                return m.qualify(a,'unused',aws,proof,m.file_sha(proof))
        return m,aws,check
    def test_fixed_original_recipe_expected_version_and_command(self):
        m=self.m; args=self.args(); value,overrides=m.input_binding(args.mode,args.input,args.input_sha256)
        self.assertEqual(value['expected']['candidateRowVersion'],'113340385')
        self.assertEqual(overrides['containerOverrides'][0]['command'],['meri-case01-setup','recover-plan','--input-env','MERI_CASE01_SETUP_INPUT','--out','/dev/shm/meri-case01-owner-receipt.jsonl'])
        self.assertLessEqual(len(m.canonical(overrides).encode()),8192)
        self.assertIs(m.sanitize.__code__.co_filename.endswith('case01-oneoff.py'),True)
        for change in [lambda x:x['expected'].update(candidateRowVersion='0'),lambda x:x['recipe']['ctx'].update(role='user_admin'),lambda x:x.update(command=['shell'])]:
            bad=copy.deepcopy(value);change(bad);self.inputs[r.PLAN_MODE].write_text(json.dumps(bad))
            with self.assertRaises(m.Refusal):m.input_binding(args.mode,args.input,m.file_sha(args.input))
    def test_pinned_original_evidence_cannot_be_replaced(self):
        with patch.object(r,'READBACK_SHA','0'*64):
            with self.assertRaisesRegex(self.m.Refusal,'ORIGINAL_EVIDENCE_CHANGED'):self.m.fixed_inputs()
    def test_immutable_inputs_parse_the_same_verified_bytes_without_reread(self):
        original_bytes=r.ORIGINAL_INPUT.read_bytes();original_path=self.root/'original-copy.json';original_path.write_bytes(original_bytes)
        read_bytes=pathlib.Path.read_bytes;reads=[]
        def interposed(path):
            value=read_bytes(path)
            if path==original_path:
                reads.append(path);path.write_text('{"recipe":{"captureRunId":"changed"}}')
            return value
        with patch.object(r,'ORIGINAL_INPUT',original_path),patch.object(pathlib.Path,'read_bytes',interposed):
            observed=self.m.fixed_inputs()
        self.assertEqual(observed['recipe'],json.loads(original_bytes)['recipe'])
        self.assertEqual(len(reads),1)
    def test_owner_plan_refuses_rebound_source_and_extra_keys(self):
        self.assertEqual(self.m.validate_owner_plan(self.plan())['candidateId'],r.CANDIDATE)
        for key,value in [('candidateRowVersion','2'),('captureRunId','other'),('originalClaimSha256','2'*64),('extra','value')]:
            bad=self.plan();bad[key]=value;body=dict(bad);body.pop('planSha256');bad['planSha256']=self.m.digest(body)
            with self.assertRaises(self.m.Refusal):self.m.validate_owner_plan(bad)
    def test_plan_and_execute_use_only_minimal_current_secret_references(self):
        for mode,expected in [(r.PLAN_MODE,self.m.DB_REFS),(r.EXECUTE_MODE,self.m.DB_REFS|{'OPENAI_API_KEY'})]:
            request=self.m.task_request(a,b.snap(),b.PROOF,mode);container=request['containerDefinitions'][0]
            self.assertEqual({x['name'] for x in container['secrets']},expected)
            self.assertEqual(container['command'],list(self.m.MODES[mode][:2]))
            self.assertEqual(request['taskRoleArn'],b.snap()['definition']['taskRoleArn'])
        bad=b.snap();bad['container']['environmentFiles']=[{'value':'opaque'}]
        with self.assertRaises(self.m.Refusal):self.m.task_request(a,bad,b.PROOF,r.EXECUTE_MODE)
    def test_actual_base_lifecycle_runs_one_task_and_verifies_plan(self):
        args,aws,_=self.prepared();result=self.run_fake(args,aws)
        self.assertEqual(result['status'],'VERIFIED');self.assertEqual(aws.calls.count(('ecs','run_task')),1)
        receipt,_,owner=self.m.plan_execution(self.m.file_sha(args.out));self.assertEqual(owner,self.plan())
        with self.assertRaises(FileExistsError):self.run_fake(args,aws)
        self.assertEqual(aws.calls.count(('ecs','run_task')),1)
    def test_failed_task_preserves_partial_journal_no_retry(self):
        args,aws,_=self.prepared();aws.run_error=True
        with self.assertRaises(self.m.Refusal):self.run_fake(args,aws)
        self.assertEqual(self.m.read_json(args.out)['status'],'RECONCILIATION_REQUIRED')
        self.assertEqual(aws.calls.count(('ecs','run_task')),1)
    def test_execute_input_requires_exact_verified_owner_plan_receipt(self):
        args,aws,_=self.prepared();self.run_fake(args,aws)
        receipt_hash=self.m.file_sha(args.out);value=self.m.fixed_inputs()
        value.update(expectedPlanSha256=self.plan()['planSha256'],ownerPlanExecutionSha256=receipt_hash)
        self.m.create(self.inputs[r.EXECUTE_MODE],value)
        _,overrides=self.m.input_binding(r.EXECUTE_MODE,self.inputs[r.EXECUTE_MODE],self.m.file_sha(self.inputs[r.EXECUTE_MODE]))
        owner=json.loads(overrides['containerOverrides'][0]['environment'][0]['value'])
        self.assertNotIn('ownerPlanExecutionSha256',owner)
        changed=self.m.read_json(args.out);changed['containerExitCode']=1;self.executions[r.PLAN_MODE].write_text(json.dumps(changed))
        with self.assertRaises(self.m.Refusal):self.m.input_binding(r.EXECUTE_MODE,self.inputs[r.EXECUTE_MODE],self.m.file_sha(self.inputs[r.EXECUTE_MODE]))
    def test_failure_fields_are_static_and_raw_data_refused(self):
        m=self.m;entry={'stage':'FIRST_CANONICAL_APPROVAL','phase':'RECONCILIATION_REQUIRED','captureRunId':r.RUN,
            'failure':{'stage':'FIRST_CANONICAL_APPROVAL','errorClass':'PrismaClientKnownRequestError','prismaCode':'P2010','sqlState':'42501'}}
        logs=lambda x:[m.PREFIX['setup']+json.dumps(x)]
        self.assertEqual(m.owner_receipts(logs(entry),r.EXECUTE_MODE,False),[entry])
        for key,value in [('message','raw database contents'),('sqlState','secret'),('stage','unowned')]:
            bad=copy.deepcopy(entry);bad['failure'][key]=value
            with self.assertRaises(m.Refusal):m.owner_receipts(logs(bad),r.EXECUTE_MODE,False)
    def test_wrong_runtime_task_override_or_digest_still_refused(self):
        args,aws,_=self.prepared();original=aws.tasks
        def changed(arns):
            rows=original(arns);rows[0]['containers'][0]['imageDigest']='sha256:'+'0'*64;return rows
        aws.tasks=changed
        with self.assertRaisesRegex(self.m.Refusal,'TASK_DIGEST_DRIFT'):self.run_fake(args,aws)
    def test_final_service_drift_prevents_run_after_registration(self):
        args,aws,_=self.prepared();changed=b.snap();changed['safe']['primaryDeploymentId']='new-owner'
        with patch.object(self.m,'qualify',return_value=b.PROOF),patch.object(self.m,'source_check',return_value=b.SOURCE),patch.object(self.m,'snapshot',side_effect=[b.snap(),changed]):
            with self.assertRaisesRegex(self.m.Refusal,'FINAL_SERVICE_DRIFT'):self.m.run(a,b.Helper(),aws,args)
        self.assertNotIn(('ecs','run_task'),aws.calls)
    def test_image_source_blobs_are_pinned_in_addition_to_main(self):
        with patch.object(a,'git',side_effect=self.source_git()):self.assertEqual(self.m.source_check(a,'unused',b.SOURCE),b.SOURCE)
        with patch.object(a,'git',side_effect=self.source_git(True)):
            with self.assertRaisesRegex(self.m.Refusal,'RECOVERY_IMAGE_SOURCE_CHANGED'):self.m.source_check(a,'unused',b.SOURCE)
    def test_execute_qualifies_actual_prior_task_definition_and_logs(self):
        m,aws,check=self.qualification()
        self.assertEqual(check()['sourceSha'],b.SOURCE)
        self.assertIn(('codebuild','batch_get_builds'),aws.calls)
        self.assertEqual(aws.calls.count(('ecs','run_task')),1) # Only the fake prior plan; qualify does not launch.
        original=copy.deepcopy(aws.definition_request)
        aws.definition_request['containerDefinitions'][0]['command']=['arbitrary-command']
        with self.assertRaisesRegex(m.Refusal,'OWNER_PLAN_DEFINITION_CHANGED'):check()
        aws.definition_request=original
        aws.logs_override=[m.PREFIX['setup']+json.dumps(dict(self.plan(),tenantRowVersion='999'))]
        with self.assertRaisesRegex(m.Refusal,'OWNER_PLAN_HASH'):check()
    def test_prior_actual_task_wrong_exit_or_override_cannot_authorize_execute(self):
        m,aws,check=self.qualification();aws.exit=1
        with self.assertRaisesRegex(m.Refusal,'OWNER_PLAN_TASK_NOT_SUCCESSFUL'):check()
        aws.exit=0;aws.overrides['containerOverrides'][0]['command'].append('unexpected')
        with self.assertRaisesRegex(m.Refusal,'TASK_OVERRIDE_DRIFT'):check()
    def complete_journal(self):
        m=self.m;base=m.fixed_inputs();client=base['recipe']['clients']['ASTER']['physicalId']
        sources={'MA1-v2':dict(frozenFixtureId='MA1-v2',physicalId='11111111-1111-4111-8111-111111111111',tenantPhysicalId=m.T1,clientPhysicalId=client,kind='memory',version=2)}
        binding=dict(caseId='01',captureRunId=r.RUN,fixtureVersion='fixture-test',physicalMapSha256=m.digest(sources),seedReceiptId='seed-123',resetReceiptId='reset-123',fixtureNamespace=m.NAMESPACE,actorUserId=base['recipe']['ctx']['userId'],clientId=client,currentVerifySha256='a'*64)
        result=dict(kind='meri-case01-execution-setup-receipt',schemaVersion=1,status='SETUP_COMPLETE',captureRunId=r.RUN,conversationId='22222222-2222-4222-8222-222222222222',ctx=base['recipe']['ctx'],clientId=client,binding=binding,bindingSha256=m.digest(binding),locatorSha256='b'*64,sourceMap=sources,currentVerifySha256='a'*64,seedReceiptId='seed-123',resetReceiptId='reset-123',projectionStatus='CANONICAL_OUTBOX_RECORDED_NOT_QUALIFIED',liveAcceptance='NOT_RUN',synthesisSubmissionCount=0)
        entries=[]
        for stage in r.STAGES:
            entries.append(dict(stage=stage,phase='INTENT',captureRunId=r.RUN))
            entries.append(dict(stage=stage,phase='VERIFIED',captureRunId=r.RUN,**{('claimSha256' if stage=='RECOVERY_ADMISSION' else 'resultSha256'):'c'*64}))
        entries.append(dict(stage='COMPLETE',phase='VERIFIED',receipt=result));return entries
    def test_completion_requires_all_stages_and_exact_binding_source_joins(self):
        m=self.m;entries=self.complete_journal();logs=lambda items:[m.PREFIX['setup']+json.dumps(x) for x in items]
        self.assertEqual(len(m.owner_receipts(logs(entries),r.EXECUTE_MODE)),19)
        for mutate in [lambda x:x.pop(2),lambda x:x[-1]['receipt']['binding'].update(actorUserId='other'),lambda x:x[-1]['receipt']['sourceMap']['MA1-v2'].update(tenantPhysicalId=m.T2),lambda x:x[-1]['receipt'].update(unexpected='data'),lambda x:x[-1]['receipt'].update(projectionStatus='QUALIFIED')]:
            bad=copy.deepcopy(entries);mutate(bad)
            with self.assertRaises(m.Refusal):m.owner_receipts(logs(bad),r.EXECUTE_MODE)

if __name__=='__main__':unittest.main()
