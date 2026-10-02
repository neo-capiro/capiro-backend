import copy,importlib.util,json,pathlib,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parent
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
t=load('old_enum_tests','case01-membership-enum-oneoff.test.py')
t.w=load('projection_wrapper','case01-projection-oneoff.py');w=t.w
def receipt():
 return {'kind':'meri-case01-projection-readback','schemaVersion':1,'status':'READBACK_COMPLETE','readOnly':True,'mutations':0,'liveAcceptance':'NOT_RUN','sourceSha':w.SOURCE,'captureRunId':w.RUN,
 'transport':{'tlsVerified':True,'caBundleSha256':'b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77'},'claims':{'originalClaimSha256':w.ORIGINAL,'recoveryClaimSha256':w.RECOVERY,'continuationClaimSha256':w.CONTINUATION},'locatorPresent':False,'bindingPresent':False,
 'state':{'candidate':{'id':'557b5b98-f591-50ce-83ea-2ca44d44567a','status':'pending','governed_status':'suggested','row_version':'113340385','clio_id':None,'item_id':None,'decided_by':None,'approved_by':None},'clio':[],'items':[],'outbox':[],'embeddings':[],'audits':[]},'role':{'name_sha256':'a'*64,'superuser':False,'bypass_rls':False},'tables':[],'policies':[],
 'visibility':{'tenantPendingJobIds':[],'systemTenantSetting':'MISSING','systemRead':{k:{'status':'READ','sqlState':None,'ids':[]} for k in ['outbox','clio','items','embeddings']}}}
t.receipt=receipt
class Tests(t.Tests):
 def test_safe_failures_never_pass(self):
  value={'kind':'meri-case01-projection-readback','schemaVersion':1,'status':'READBACK_FAILED','readOnly':True,'mutations':0,'liveAcceptance':'NOT_RUN','stage':'CURRENT_APPROVAL','code':'42501'}
  self.assertEqual(self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE,False),[value])
  with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE)
  value['code']='unbounded detail'
  with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE,False)
 def test_actual_committed_state_is_observed_not_refused_as_pending(self):
  value=receipt();c=value['state']['candidate'];c.update(status='approved',governed_status='active',row_version='113340399',clio_id='11111111-1111-4111-8111-111111111111',item_id='22222222-2222-4222-8222-222222222222')
  value['state']['clio']=[{'id':c['clio_id'],'row_version':'113340399','source_version':'2026-10-02T12:00:00.000Z','legacy_embedding_present':False,'content_sha256':'a'*64}]
  value['state']['items']=[{'id':c['item_id'],'row_version':'113340399','status':'active','governed_status':'active','approved_by':None,'source_version_sha256':None,'source_content_hash_sha256':None,'projection_content_sha256':'b'*64}]
  self.assertEqual(self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE),[value])
  value['state']['items'][0]['id']='33333333-3333-4333-8333-333333333333'
  with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE)
 def test_no_payload_or_error_string_can_escape(self):
  for mutate in [lambda r:r['state'].update(payload='content'),lambda r:r['state']['candidate'].update(status='full error text'),lambda r:r['claims'].update(continuationClaimSha256='0'*64),lambda r:r['role'].update(authorization='bad')]:
   value=receipt();mutate(value)
   with self.assertRaises(self.m.Refusal):self.m.owner_receipts([w.PREFIX+json.dumps(value)],w.MODE)
 def test_fixed_tls_and_readonly_transactions(self):
  text=w.SCRIPT.read_text();old=(ROOT/'case01-membership-enum-readonly-v2.mjs').read_text()
  segment=lambda s:s.split('// BEGIN FIXED RDS TLS OPTIONS')[1].split('// END FIXED RDS TLS OPTIONS')[0]
  self.assertEqual(segment(text),segment(old));self.assertEqual(text.count("query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')"),2)
  self.assertNotIn('EXPLAIN',text);self.assertNotIn('UPDATE ',text);self.assertNotIn('INSERT ',text);self.assertNotIn('DELETE ',text)
if __name__=='__main__':unittest.main()
