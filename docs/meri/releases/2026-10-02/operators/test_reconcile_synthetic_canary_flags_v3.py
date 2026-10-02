import copy,importlib.util,pathlib,unittest
from unittest.mock import Mock,patch
ROOT=pathlib.Path(__file__).parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
a=load('adapter','synthetic-canary-codebuild.py');r=load('reconciler','reconcile-synthetic-canary-flags-v3.py')
class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.old=a.read_json(ROOT/'synthetic-canary-plan-v2.json');self.new=a.read_json(ROOT/'synthetic-canary-plan-v3.json');self.receipt=a.read_json(ROOT/'synthetic-canary-flags-before-v2.json');self.blocked=a.read_json(ROOT/'synthetic-canary-apply-v2.json');self.qual=a.read_json(ROOT/'synthetic-canary-qualification.json');self.old_source=(ROOT/'synthetic-canary-codebuild-before-inference.py').read_bytes();self.new_source=(ROOT/'synthetic-canary-codebuild.py').read_bytes()
    def verify(self):return r.verify_inputs(a,self.old,self.new,self.receipt,self.blocked,self.old_source,self.new_source)
    def rehash(self,value,key):value[key]=a.digest({k:v for k,v in value.items() if k!=key})
    def test_actual_saved_inputs_bind_exact_source_scope_and_receipt(self):
        self.assertEqual(set(self.verify()),set(self.old)-r.CHANGING_PLAN_FIELDS)
    def test_changed_scope_proof_snapshot_or_web_fails_even_with_rehashed_plan(self):
        original=copy.deepcopy(self.new)
        for key in ('operatorSourceSha','qualificationHash','proofs','tenants','services','web'):
            self.new=copy.deepcopy(original);self.new[key]='different';self.rehash(self.new,'planHash')
            with self.subTest(key=key),self.assertRaisesRegex(a.Refusal,'changed'):self.verify()
    def test_original_receipt_tampering_is_rejected(self):
        self.receipt['priorStates'][0]['state']={'present':True,'value':False}
        with self.assertRaisesRegex(a.Refusal,'receipt integrity'):self.verify()
    def test_old_apply_cannot_have_reached_mutations(self):
        self.blocked['flagJobs']=[{'status':'RUN_INTENT'}]
        with self.assertRaisesRegex(a.Refusal,'stopped before writes'):self.verify()
    def test_any_additional_adapter_patch_is_rejected(self):
        self.new_source+=b'\n# unrelated delta\n';self.new['adapterSha256']=r.hashlib.sha256(self.new_source).hexdigest();self.rehash(self.new,'planHash')
        with self.assertRaisesRegex(a.Refusal,'exactly the reviewed'):self.verify()
    def derive(self,before,after):
        aws=Mock();snapshots={name:{'safe':value} for name,value in self.new['services'].items()}
        with patch.object(a,'verify_plan'),patch.object(a,'verify_web',return_value=self.new['web']),patch.object(a,'snapshot',side_effect=lambda aws,helper,name,proof:snapshots[name]),patch.object(a,'check_targets'),patch.object(a,'read_flag_result',return_value=(before,after)) as authoritative:
            result=r.derive(a,aws,None,None,self.old,self.new,self.receipt,self.blocked,self.qual,self.old_source,self.new_source)
            authoritative.assert_called_once_with(aws,None,None,self.new,snapshots['api'],self.receipt['flagJobs'][0],'plan',None)
            aws.identity.assert_called_once_with(self.qual['expectedCallerArn'])
        return result
    def test_derived_receipt_preserves_actual_job_and_times_explicitly_records_reuse(self):
        result=self.derive(self.receipt['priorStates'],self.receipt['priorStates'])
        self.assertEqual(result['flagJobs'],self.receipt['flagJobs']);self.assertEqual(result['startedAtEpoch'],self.receipt['startedAtEpoch']);self.assertEqual(result['completedAtEpoch'],self.receipt['completedAtEpoch'])
        self.assertEqual(result['planHash'],self.new['planHash']);self.assertEqual(result['reconciliation']['sourceReceiptHash'],self.receipt['receiptHash']);self.assertEqual(result['reconciliation']['newTasksLaunched'],0);self.assertEqual(result['reconciliation']['cloudMutations'],0)
        self.assertEqual(result['receiptHash'],a.digest({k:v for k,v in result.items() if k!='receiptHash'}));self.assertNotIn('reconciliation',self.receipt)
    def test_authoritative_task_result_must_match_saved_original_states(self):
        different=copy.deepcopy(self.receipt['priorStates']);different[0]['state']={'present':True,'value':False}
        with self.assertRaisesRegex(a.Refusal,'authoritative flag task'):self.derive(different,different)
if __name__=='__main__':unittest.main(verbosity=2)
