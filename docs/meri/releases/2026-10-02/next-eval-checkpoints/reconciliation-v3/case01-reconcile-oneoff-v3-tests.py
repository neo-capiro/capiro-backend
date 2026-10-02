import copy, importlib.util, json, pathlib, tempfile, types, unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fixed_reconcile', ROOT / 'case01-reconcile-oneoff-v3.py')
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
spec = importlib.util.spec_from_file_location('old_oneoff_tests', ROOT / 'case01-oneoff-tests.py')
old = importlib.util.module_from_spec(spec); spec.loader.exec_module(old)

def valid_receipt():
    return {'kind':'meri-case01-readonly-reconciliation','schemaVersion':1,'status':'READBACK_COMPLETE','readOnly':True,'mutations':0,'liveAcceptance':'NOT_RUN',
            'captureRunId':'c6ffa5ad-dd9f-4912-bc31-a03231a9b903','transport':{'tlsVerified':True,'caBundleSha256':'b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77'},
            'claim':{'status':'CLAIMED','recipeSha256':'29cc20de9afb70ec31e009afd0b7c3226482f1372b05d2ccec7e86a835ec0142','locatorPresent':False,'bindingPresent':False},
            'guardAudit':{'kind':'deployed_pending_candidate_predicate_comparison','candidateId':'557b5b98-f591-50ce-83ea-2ca44d44567a','rowVersion':'113340385','identityValidated':True,'predicateCount':len(w.PREDICATES),'mismatchFields':[],
              'expectedPayloadSha256':'a'*64,'actualPayloadSha256':'a'*64,'expectedProvenanceSha256':'b'*64,'actualProvenanceSha256':'b'*64,'predicateMatch':True,'canonicalGuardExecuted':False},
            'currentPolicyDecision':{'owner':'MemoryAuthorizationService.evaluateInTx','operation':'approve','allowed':True,'basis':'explicit_grant','emitDenialMetrics':False,'capabilityIssued':False,'governanceTenantBound':True},
            'outboxProjectionColumns':[{'name':'expected_source_version','exists':False},{'name':'expected_content_hash','exists':True,'type':'character varying(64)','nullable':True,'defaultPresent':False,'defaultSql':None,'defaultSha256':None}],
            **{k:[] for k in ['actors','grants','walls','expectedCandidates','candidates','items','outbox','embeddings']}}

class Aws:
    def __init__(self, m): self.m=m; self.calls=[]; self.request=None; self.overrides=None; self.run_error=False; self.exit=0; self.bad_definition=False; self.bad_task=False; self.bad_receipt=False
    def identity(self, caller): assert caller == self.m.CALLER
    def task_arns(self, **kwargs): return []
    def definition(self, arn):
        row=copy.deepcopy(self.request)
        if self.bad_definition: row['containerDefinitions'][0]['entryPoint'][-1] += '\n// changed'
        row['containerDefinitions'][0]['environment'].reverse()
        return {'taskDefinition': row}
    def call(self, service, operation, **kwargs):
        self.calls.append(operation)
        if operation == 'register_task_definition':
            self.request=copy.deepcopy(kwargs)
            return {'taskDefinition': {'taskDefinitionArn': self.td}}
        assert operation == 'run_task'
        self.overrides=copy.deepcopy(kwargs['overrides'])
        if self.run_error: raise RuntimeError('unknown run acknowledgement')
        return {'tasks': [{'taskArn': self.task}]}
    @property
    def td(self): return f'arn:aws:ecs:us-east-1:967807252336:task-definition/{w.FAMILY}:1'
    @property
    def task(self): return 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'d'*32
    def tasks(self, arns):
        overrides=dict(self.overrides, inferenceAcceleratorOverrides=[])
        if self.bad_task: overrides['taskRoleArn']='changed'
        return [{'taskArn': self.task, 'clusterArn': 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev', 'taskDefinitionArn': self.td,
                 'lastStatus': 'STOPPED', 'overrides': overrides, 'containers': [{'name': w.CONTAINER, 'imageDigest': old.DIGEST, 'lastStatus': 'STOPPED', 'exitCode': self.exit}]}]
    def logs(self, group, stream):
        value=valid_receipt()
        if self.bad_receipt: value['mutations']=1
        return ['ignored raw service line', w.PREFIX+json.dumps(value)]

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='reconcile-offline-',dir=ROOT)
        self.root=pathlib.Path(self.temp.name).resolve(); self.assertEqual(self.root.parent,ROOT)
        script=self.root/'fixed.mjs'; script.write_text('// Fixed UNIT diagnostic; never executed.\n')
        source=old.m
        inp=self.root/'input.json'; inp.write_text(json.dumps({'recipe':{'ctx':{'tenantId':source.T1,'tenantSlug':source.NAMESPACE+'-t1','role':'standard_user','userId':'44444444-4444-4444-8444-444444444444'}}}))
        failed=self.root/'failed.json'; failed.write_text(json.dumps({'status':'RECONCILIATION_REQUIRED','mode':'setup-execute','sourceSha':w.SOURCE,'containerExitCode':1,'code':'OWNER_PROCESS_FAILED','taskArn':'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/69867ce349464296a6c613aaa6b08960'}))
        self.patches=[patch.object(w,'SCRIPT',script),patch.object(w,'SCRIPT_SHA',source.file_sha(script)),patch.object(w,'INPUT',inp),patch.object(w,'INPUT_SHA',source.file_sha(inp)),patch.object(w,'FAILED',failed),patch.object(w,'FAILED_SHA',source.file_sha(failed))]
        for p in self.patches:p.start()
        self.m=w.load_operator(); self.m.ROOT=self.root; self.a=self.m.adapter()
        self.proof=dict(old.PROOF, sourceSha=w.SOURCE,operatorHead=w.SOURCE)
        self.snap=old.snap()
        for row in self.snap['container']['environment']:
            if row['name'] in ['GIT_SHA','RELEASE_SHA']:row['value']=w.SOURCE
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.assertEqual(self.root.parent,ROOT);self.temp.cleanup()
    def prepare(self):
        m=self.m
        args=types.SimpleNamespace(repo='UNIT',proof='UNIT',proof_sha256='f'*64,input=str(w.INPUT),input_sha256=w.INPUT_SHA,mode=w.MODE,out=str(self.root/'plan.json'))
        aws=Aws(m)
        with patch.object(m,'qualify',return_value=self.proof),patch.object(m,'snapshot',return_value=self.snap):
            m.prepare(self.a,old.Helper(),aws,args)
        plan=m.read_json(args.out);args.plan=args.out;args.plan_sha256=plan['planHash'];args.out=str(self.root/'execution.json');args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
        return args,aws,plan
    def run_fake(self,args,aws):
        with patch.object(self.m,'qualify',return_value=self.proof),patch.object(self.m,'snapshot',return_value=self.snap),patch.object(self.m,'source_check',return_value=w.SOURCE),patch.object(self.m.time,'sleep'):
            return self.m.run(self.a,old.Helper(),aws,args)
    def test_fixed_minimal_request_and_input(self):
        request=self.m.task_request(self.a,self.snap,self.proof,w.MODE)
        self.assertEqual(request['family'],w.FAMILY)
        c=request['containerDefinitions'][0]
        self.assertEqual(c['name'],w.CONTAINER)
        self.assertEqual(c['entryPoint'],['node','--input-type=module','--eval',w.SCRIPT.read_text()])
        self.assertEqual(c['command'],[])
        self.assertEqual({r['name'] for r in c['secrets']},self.m.DB_REFS)
        self.assertEqual({r['name'] for r in c['environment']},{'DB_NAME','GIT_SHA','RELEASE_SHA','TMPDIR','MERI_SYNTHETIC_FIXTURE_NAMESPACE','MEMORY_GOVERNANCE_TENANTS'} | set(self.m.FLAGS))
        _,overrides=self.m.input_binding(w.MODE,w.INPUT,w.INPUT_SHA)
        self.assertEqual(overrides['containerOverrides'][0]['command'],[])
        self.assertEqual(overrides['containerOverrides'][0]['environment'][0]['name'],w.VARIABLE)
        for mode,path,hash_value in [('setup-execute',w.INPUT,w.INPUT_SHA),(w.MODE,w.SCRIPT,w.INPUT_SHA),(w.MODE,w.INPUT,'0'*64)]:
            with self.assertRaises(self.m.Refusal):self.m.input_binding(mode,path,hash_value)
    def test_bound_source_files_cannot_change(self):
        self.m.fixed_files()
        w.SCRIPT.write_text('// changed')
        with self.assertRaises(self.m.Refusal):self.m.task_request(self.a,self.snap,self.proof,w.MODE)
    def test_exact_readonly_task_once_and_authoritative_receipt(self):
        args,aws,plan=self.prepare();result=self.run_fake(args,aws)
        self.assertEqual(result['status'],'VERIFIED')
        self.assertEqual(aws.calls,['register_task_definition','run_task'])
        receipt=self.m.read_json(args.out)
        self.assertEqual(receipt['containerExitCode'],0)
        self.assertEqual(len(receipt['ownerReceipts']),1)
        self.assertNotIn('ignored raw',json.dumps(receipt))
        with self.assertRaises(FileExistsError):self.run_fake(args,aws)
        self.assertEqual(aws.calls.count('run_task'),1)
    def test_unknown_acknowledgement_does_not_retry(self):
        args,aws,_=self.prepare();aws.run_error=True
        with self.assertRaises(self.m.Refusal):self.run_fake(args,aws)
        self.assertEqual(aws.calls.count('run_task'),1)
        self.assertEqual(self.m.read_json(args.out)['status'],'RECONCILIATION_REQUIRED')
    def test_changed_registered_script_never_runs(self):
        args,aws,_=self.prepare();aws.bad_definition=True
        with self.assertRaises(self.m.Refusal):self.run_fake(args,aws)
        self.assertEqual(aws.calls,['register_task_definition'])
    def test_bad_runtime_authority_or_exit_or_receipt_cannot_pass(self):
        for field in ['bad_task','exit','bad_receipt']:
            # Each distinct prepared operation remains independently durable.
            for path in ['plan.json','execution.json']:
                p=self.root/path
                if p.exists():p.unlink()
            args,aws,_=self.prepare();setattr(aws,field,True if field!='exit' else 1)
            with self.assertRaises(self.m.Refusal):self.run_fake(args,aws)
            self.assertEqual(self.m.read_json(args.out)['status'],'RECONCILIATION_REQUIRED')
    def test_raw_or_sensitive_or_duplicate_receipts_refused(self):
        with self.assertRaises(self.m.Refusal):self.m.owner_receipts(['unprefixed text'],w.MODE)
        for value in [{'password':'must not retain'}, {'kind':'wrong'}]:
            with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE)
        line=w.PREFIX+json.dumps(valid_receipt())
        with self.assertRaises(self.m.Refusal):self.m.owner_receipts([line,line],w.MODE)

    def test_exact_current_service_governance_environment_not_reconstructed(self):
        env=self.snap['container']['environment']
        for row in env:
            if row['name']=='MEMORY_GOVERNANCE_TENANTS':row['value']=self.m.T2+','+self.m.T1+',11111111-1111-4111-8111-111111111111'
        request=self.m.task_request(self.a,self.snap,self.proof,w.MODE)
        original={row['name']:row['value'] for row in env}
        actual={row['name']:row['value'] for row in request['containerDefinitions'][0]['environment']}
        for key in ['MERI_SYNTHETIC_FIXTURE_NAMESPACE','MEMORY_GOVERNANCE_TENANTS',*self.m.FLAGS]:self.assertEqual(actual[key],original[key])
        for key,bad in [('MERI_SYNTHETIC_FIXTURE_NAMESPACE','other'),('MEMORY_GOVERNANCE_TENANTS',self.m.T2),*[(k,'observe') for k in self.m.FLAGS]]:
            changed=copy.deepcopy(self.snap)
            for row in changed['container']['environment']:
                if row['name']==key:row['value']=bad
            with self.assertRaises(self.m.Refusal):self.m.task_request(self.a,changed,self.proof,w.MODE)

    def test_guard_receipt_is_literal_names_hashes_exact_candidate_and_safe_booleans(self):
        valid=valid_receipt()
        for key,value in [('candidateId','foreign'),('rowVersion','999'),('identityValidated',False),('predicateCount',1),('canonicalGuardExecuted',True),('mismatchFields',['RAW_PRIVATE_BODY']),('mismatchFields',['status','status']),('mismatchFields',['payload_jsonb']),('expectedPayloadSha256','bad'),('predicateMatch',False),('rawPayload','secret')]:
            bad=copy.deepcopy(valid);bad['guardAudit'][key]=value
            with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(bad)],w.MODE)
        valid['guardAudit'].update(mismatchFields=['status'],predicateMatch=False)
        self.assertEqual(self.m.owner_receipts([w.PREFIX+json.dumps(valid)],w.MODE),[valid])
        valid['guardAudit'].update(mismatchFields=['payload_jsonb','status'],actualPayloadSha256='c'*64)
        self.assertEqual(self.m.owner_receipts([w.PREFIX+json.dumps(valid)],w.MODE),[valid])

    def test_authorization_receipt_does_not_claim_mutation_or_unbound_selection(self):
        for key,value in [('basis','unknown'),('allowed','true'),('capabilityIssued',True),('emitDenialMetrics',True),('governanceTenantBound',False),('operation','revoke'),('rawReason','private')]:
            bad=valid_receipt();bad['currentPolicyDecision'][key]=value
            with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(bad)],w.MODE)
        denied=valid_receipt();a=denied['currentPolicyDecision'];a.pop('basis');a.update(allowed=False,reason='missing_grant')
        self.assertEqual(self.m.owner_receipts([w.PREFIX+json.dumps(denied)],w.MODE),[denied])

    def test_catalog_receipt_only_fixed_two_columns_masked_defaults(self):
        for key,value in [('name','private_column'),('exists',1),('type','RAW_TYPE'),('nullable','yes'),('defaultPresent',True),('defaultSql','RAW_DEFAULT'),('defaultSha256','bad'),('rawColumn','private')]:
            bad=valid_receipt();bad['outboxProjectionColumns'][1][key]=value
            with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(bad)],w.MODE)
        safe=valid_receipt();safe['outboxProjectionColumns'][1].update(type='UNRECOGNIZED',typeSha256='c'*64,defaultPresent=True,defaultSql='REDACTED',defaultSha256='d'*64)
        self.assertEqual(self.m.owner_receipts([w.PREFIX+json.dumps(safe)],w.MODE),[safe])

    def test_prior_success_readback_is_immutable(self):
        self.m.fixed_files()
        with patch.object(w,'PREVIOUS_SHA','0'*64):
            with self.assertRaises(self.m.Refusal):self.m.fixed_files()

    def test_representative_v3_receipt_keeps_actual_prior_rows_and_unchanged_base_sanitizer(self):
        self.assertEqual(pathlib.Path(self.m.sanitize.__code__.co_filename).resolve(),w.BASE)
        value=copy.deepcopy(self.m.read_json(w.PREVIOUS)['ownerReceipts'][0])
        specimen=valid_receipt()
        for key in ['guardAudit','currentPolicyDecision','outboxProjectionColumns']:value[key]=specimen[key]
        # Existing actual v2 row arrays plus representative new diagnostic fields.
        # This is an offline schema check, never a new observed DB result.
        self.assertEqual(self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE),[value])
        for old_key in ['currentAuthorization','canonicalWithdrawalGuardExecuted']:
            bad=copy.deepcopy(value);bad[old_key]='blocked'
            with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(bad)],w.MODE)

if __name__=='__main__':unittest.main(verbosity=2)
