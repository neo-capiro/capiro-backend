"""Actual NTFS disposable copies. UNIT proof is never enabled against live root."""
import copy,json,pathlib,runpy,tempfile,unittest,subprocess,sys
BASE=pathlib.Path(__file__).resolve().parent
M=runpy.run_path(str(BASE/'windows-capture-spend.draft.py'));EXECUTE=M['execute'];G=EXECUTE.__globals__
WIRE=(BASE/'journal25-reconstructed-from-retained.jsonl').read_bytes()
PROOF=json.loads((BASE/'proof.unit.json').read_bytes())
AUTH=pathlib.Path('C:/dev/main/meri-c1-20261002/evals/meri/live-v1/tests/fixtures/case01-failed-receipt-authorization.unit.json').read_bytes()
class Native(unittest.TestCase):
 def setUp(self):
  parent=BASE/'ntfs-tests';parent.mkdir(exist_ok=True)
  self.root=pathlib.Path(tempfile.mkdtemp(prefix='isolated-',dir=parent))
  assert self.root.resolve().is_relative_to(parent.resolve())
  (self.root/'run-authorization.json').write_bytes(AUTH)
  (self.root/'fresh-spend.jsonl').write_bytes(b''.join(WIRE.splitlines(keepends=True)[:20]))
  self.previous_root=G['FRESH_ROOT'];G['FRESH_ROOT']=str(self.root)
  self.prior=self.call('adopt')
  (self.root/'fresh-spend.jsonl').write_bytes(WIRE)
  self.prior['state']['files']['fresh-spend.jsonl'].update(sha256=M['digest'](WIRE),bytes=len(WIRE))
  self.prior=self.call('read',self.prior)
  # Only disposable child and this process are configured for the UNIT proof/time.
  G['CASE14_TERMINAL_PROOF_SHA256']=M['digest'](M['data'](PROOF))
  self.old_time=G['time'].time;G['time'].time=lambda:(PROOF['observedAtMs']+1000)/1000
  self.event={'kind':'reconcile_terminal',**{k:PROOF[k]for k in('caseId','captureRunId','reservationId')},'proof':copy.deepcopy(PROOF)}
 def tearDown(self):
  G['FRESH_ROOT']=self.previous_root;G['CASE14_TERMINAL_PROOF_SHA256']=None;G['time'].time=self.old_time
 def call(self,op,prior=None,event=None):
  return EXECUTE({'op':'fresh_'+op,'root':str(self.root),**({'state':prior['state']}if prior else{}),**({'event':event}if event else{})})
 def test_disabled_default_refuses_even_exact_unit_proof(self):
  G['CASE14_TERMINAL_PROOF_SHA256']=None
  with self.assertRaises((ValueError,TypeError)):self.call('reconcile_terminal',self.prior,self.event)
  self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),WIRE)
 def test_exact_append_separates_known_recall_from_conservative_approval(self):
  done=self.call('reconcile_terminal',self.prior,self.event);snap=done['snapshot'];row=snap['runs']['14:'+PROOF['captureRunId']]
  self.assertEqual(snap['eventCount'],26);self.assertIsNone(snap['activeRun'])
  self.assertEqual(snap['knownSettledCostMicros'],15_200_909);self.assertEqual(snap['conservativeApprovalCostMicros'],1_000_000)
  self.assertEqual(snap['committedCostMicros'],16_200_909);self.assertEqual(snap['remainingReservationMicros'],13_799_091)
  self.assertFalse(row['captureAuthority']);self.assertEqual(row['captureStatus'],'CAPTURE_UNCERTAIN');self.assertEqual(row['answerGrade'],'NOT_EVALUATED')
  self.assertIsNone(row['approvalBilledActualMicros']);self.assertEqual(row['chargedCostMicros'],1_569_851)
  after=(self.root/'fresh-spend.jsonl').read_bytes();self.assertTrue(after.startswith(WIRE));self.assertEqual(len(after.splitlines()),26)
  self.assertEqual(self.call('read',done)['snapshot'],snap)
 def test_tampering_never_appends(self):
  for field,value in [('chargedCostMicros',0),('conservativeApprovalCostMicros',0),('approvalBilledActualMicros',1000000),('captureAuthority',True),('answerGrade','PASS'),('captureStatus','CAPTURE_COMPLETE'),('conversationId',PROOF['captureRunId']),('pendingProviderAttempts',1),('unexpected',True)]:
   event=copy.deepcopy(self.event);event['proof'][field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,event)
  for field,value in [('caseId','20'),('reservationId',PROOF['captureRunId']),('kind','settle')]:
   event={**self.event,field:value}
   with self.subTest(field=field),self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,event)
  self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),WIRE)
 def test_replay_stale_checkpoint_and_new_adoption_fail(self):
  done=self.call('reconcile_terminal',self.prior,self.event)
  for op,prior,event in [('reconcile_terminal',self.prior,self.event),('reconcile_terminal',done,self.event),('adopt',None,None),('read',self.prior,None)]:
   with self.subTest(op=op),self.assertRaises(ValueError):self.call(op,prior,event)
 def test_prefix_drift_even_with_updated_descriptor_fails(self):
  bad=WIRE.replace(b'1791092997130',b'1791092997131');self.assertNotEqual(bad,WIRE)
  (self.root/'fresh-spend.jsonl').write_bytes(bad);self.prior['state']['files']['fresh-spend.jsonl'].update(sha256=M['digest'](bad),bytes=len(bad))
  with self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,self.event)
  self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),bad)
 def test_same_bytes_different_file_identity_fails(self):
  journal=self.root/'fresh-spend.jsonl';journal.rename(self.root/'original-preserved.jsonl');journal.write_bytes(WIRE)
  with self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,self.event)
 def test_partial_append_preserves_prefix_and_fails_closed(self):
  n=G['native'];original=n['Write'];calls=0
  def partial(handle,buffer,size,count,overlap):
   nonlocal calls
   calls+=1
   if calls>1:raise OSError('UNIT partial write')
   return original(handle,buffer,size//2,count,overlap)
  n['Write']=partial
  try:
   with self.assertRaises(OSError):self.call('reconcile_terminal',self.prior,self.event)
  finally:n['Write']=original
  self.assertTrue((self.root/'fresh-spend.jsonl').read_bytes().startswith(WIRE))
  with self.assertRaises(ValueError):self.call('read',self.prior)
 def test_existing_writer_excludes_append(self):
  script="""import runpy,sys,contextlib
m=runpy.run_path(sys.argv[1]);n=m['native'];d,parts=m['protocol']['components'](sys.argv[2],root=True)
with contextlib.ExitStack() as s:
 p=s.enter_context(n['open_volume'](d))
 for part in parts:p=s.enter_context(n['open_child'](p,part,True))
 h=s.enter_context(n['open_child'](p,'fresh-spend.jsonl',False,write=True))
 print('LOCKED',flush=True);sys.stdin.readline()
"""
  child=subprocess.Popen([sys.executable,'-I','-c',script,str(BASE/'windows-capture-spend.draft.py'),str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   self.assertEqual(child.stdout.readline().strip(),'LOCKED')
   with self.assertRaises(OSError):self.call('reconcile_terminal',self.prior,self.event)
  finally:child.communicate('\n',timeout=10)
  self.assertEqual(child.returncode,0);self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),WIRE)
if __name__=='__main__':unittest.main(verbosity=2)
