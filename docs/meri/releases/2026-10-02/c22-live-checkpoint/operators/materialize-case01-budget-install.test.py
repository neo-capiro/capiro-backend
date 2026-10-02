import copy, importlib.util, json, pathlib, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('budget_input_owner',ROOT/'materialize-case01-budget-install.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NOW=1790937000
def sample():
    binding={'caseId':'01','captureRunId':'unit-run','currentVerifySha256':'a'*64}
    setup={'kind':'meri-case01-execution-setup-receipt','status':'SETUP_COMPLETE','synthesisSubmissionCount':0,
      'ctx':{'role':'standard_user','tenantId':'unit-tenant','userId':'unit-user'},'clientId':'unit-client','captureRunId':'unit-run',
      'binding':binding,'bindingSha256':m.digest(binding),'currentVerifySha256':'a'*64}
    owner={'status':'READY_FOR_RATE_QUALIFICATION','caseId':'01','captureRunId':'unit-run','currentVerifySha256':'a'*64,
      'captureBindingSha256':setup['bindingSha256'],'priorQualificationSha256':m.digest(None),'tenantRowVersion':'123','liveAcceptance':'NOT_RUN'}
    plan={'mode':'budget-plan','sourceSha':m.SOURCE,'proofSha256':m.PROOF_SHA,'operatorSha256':m.BASE_SHA,'inputSha256':m.INPUT_SHA,
      'createdAt':NOW-60,'expiresAt':NOW+1200,'operationId':'unit-operation','operatorHead':'unit-head'}
    plan['planHash']=m.digest(plan)
    execution={'status':'VERIFIED','mode':'budget-plan','sourceSha':m.SOURCE,'containerExitCode':0,'planHash':plan['planHash'],
      'operationId':plan['operationId'],'operatorHead':plan['operatorHead'],'taskArn':'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+'1'*32,'ownerReceipts':[owner]}
    recovery={'status':'VERIFIED','mode':'setup-recovery-execute','sourceSha':m.SOURCE,'containerExitCode':0,
      'ownerReceipts':[{'stage':'COMPLETE','phase':'VERIFIED','receipt':setup}]}
    original={'target':'capiro-dev','fixtureNamespace':'meri-foundation-20260928','ctx':setup['ctx'],'clientId':setup['clientId']}
    # Actual frozen public rate evidence; never dispatch to a provider or alter it.
    rate=m.pinned(ROOT.parent/'oct02-original-eval'/'reviewed-rate-evidence-20261002.json',m.RATE_SHA)
    return [plan,execution,recovery,original,rate,NOW]
class Cases(unittest.TestCase):
    def test_exact_cas_and_rate_fields_copied(self):
        args=sample();result=m.derive(*args);owner=args[1]['ownerReceipts'][0]
        self.assertEqual(result['expectedTenantRowVersion'],owner['tenantRowVersion'])
        self.assertEqual(result['expectedPriorQualificationSha256'],owner['priorQualificationSha256'])
        self.assertEqual(result['qualification']['rateEvidenceSha256'],m.digest(args[4]))
        self.assertEqual(result['qualification']['rates'],args[4]['rates'])
        self.assertEqual((result['qualification']['maxCostMicros'],result['qualification']['maxTokens'],result['qualification']['maxAttempts']),(3000000,200000,32))
        self.assertLessEqual(len(m.canonical(result).encode()),6000)
    def test_modified_expired_or_other_source_task_plan_rejected(self):
        for key,value in [('planHash','f'*64),('sourceSha','f'*40),('operatorSha256','f'*64),('inputSha256','f'*64),('proofSha256','f'*64),('expiresAt',NOW-1)]:
            args=sample();args[0][key]=value
            if key!='planHash':args[0]['planHash']=m.digest({k:v for k,v in args[0].items() if k!='planHash'})
            with self.assertRaises(m.Refusal):m.derive(*args)
    def test_failed_unbound_or_foreign_plan_receipt_rejected(self):
        for key,value in [('status','RECONCILIATION_REQUIRED'),('containerExitCode',1),('planHash','f'*64),('operationId','foreign'),('operatorHead','foreign'),('taskArn','foreign')]:
            args=sample();args[1][key]=value
            with self.assertRaises(m.Refusal):m.derive(*args)
    def test_current_binding_case_previous_qualification_and_recovery_required(self):
        for key,value in [('caseId','20'),('captureRunId','foreign'),('currentVerifySha256','f'*64),('captureBindingSha256','f'*64),('priorQualificationSha256','f'*64),('tenantRowVersion','')]:
            args=sample();args[1]['ownerReceipts'][0][key]=value
            with self.assertRaises(m.Refusal):m.derive(*args)
        args=sample();args[2]['status']='RECONCILIATION_REQUIRED'
        with self.assertRaises(m.Refusal):m.derive(*args)
    def test_expired_rate_scope_and_token_contract_rejected(self):
        for key,value in [('expiresAt','2026-10-02T00:00:00Z'),('maxTokens',300000),('priceKind','guessed')]:
            args=sample();args[4][key]=value
            with self.assertRaises(m.Refusal):m.derive(*args)
    def test_pinned_json_uses_same_verified_bytes_and_rejects_duplicates(self):
        class Replacing:
            calls=0
            def read_bytes(self):
                self.calls+=1
                return b'{"value":"verified"}' if self.calls==1 else b'{"value":"changed"}'
        path=Replacing();self.assertEqual(m.pinned(path,m.sha(b'{"value":"verified"}'))['value'],'verified');self.assertEqual(path.calls,1)
        class Duplicate:
            def read_bytes(self):return b'{"value":1,"value":2}'
        with self.assertRaises(m.Refusal):m.pinned(Duplicate(),m.sha(b'{"value":1,"value":2}'))
    def test_frozen_operator_ingress_and_sensitive_filter_accept_real_derived_shape(self):
        path=ROOT.parent/'oct02-case01-release'/'case01-oneoff.py'
        self.assertEqual(m.sha(path.read_bytes()),m.BASE_SHA)
        loader=importlib.util.spec_from_file_location('frozen_budget_base_test',path);base=importlib.util.module_from_spec(loader);loader.loader.exec_module(base)
        result=m.derive(*sample());base.sanitize(result)
        self.assertEqual(base.MODES['budget-install'],('meri-capture-provider-budget','install','MERI_CAPTURE_PROVIDER_BUDGET_INPUT'))
if __name__=='__main__':unittest.main()
