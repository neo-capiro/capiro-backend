"""Actual NTFS cost-only append checks over disposable exact-evidence copies."""
import copy,json,pathlib,runpy,tempfile,unittest,uuid,subprocess,sys
BASE=pathlib.Path('C:/dev/main/meri-c1-20261002/evals/meri/live-v1/tests')
MODULE=runpy.run_path(str(BASE.parent/'lib/windows-capture-spend.py'))
EXECUTE=MODULE['execute']; G=EXECUTE.__globals__
LIVE=pathlib.Path(G['FRESH_ROOT'])
AUTHORIZATION=(BASE/'fixtures/case01-failed-receipt-authorization.unit.json').read_bytes()
WIRE=(BASE/'fixtures/case01-failed-receipt-journal21.unit.jsonl').read_bytes()
INPUT=json.loads((BASE/'fixtures/case01-failed-receipt-cost.unit.json').read_bytes())
PROOF=json.loads((BASE/'fixtures/case01-failed-receipt-cost-proof.unit.json').read_bytes())
PARENT=pathlib.Path('C:/dev/main/outputs/meri-c2-20261003/cost-supervised-v1/case01-legacy-native')
PARENT.mkdir(exist_ok=True)

class TerminalCost(unittest.TestCase):
 def setUp(self):
  self.root=pathlib.Path(tempfile.mkdtemp(prefix='ntfs-',dir=PARENT))
  (self.root/'run-authorization.json').write_bytes(AUTHORIZATION)
  (self.root/'fresh-spend.jsonl').write_bytes(b''.join(WIRE.splitlines(keepends=True)[:20]))
  G['FRESH_ROOT']=str(self.root)
  self.prior=self.call('adopt')
  # Only the disposable file is restored to the already-observed exact21 bytes.
  (self.root/'fresh-spend.jsonl').write_bytes(WIRE)
  self.prior['state']['files']['fresh-spend.jsonl'].update(sha256=MODULE['digest'](WIRE),bytes=len(WIRE))
  self.prior=self.call('read',self.prior)
  self.event={'kind':'reconcile_terminal',**{k:PROOF[k] for k in ('caseId','captureRunId','reservationId')},'proof':copy.deepcopy(PROOF)}
 def tearDown(self):
  G['FRESH_ROOT']=str(LIVE)
 def call(self,op,prior=None,event=None):
  return EXECUTE({'op':'fresh_'+op,'root':str(self.root),**({'state':prior['state']} if prior else {}),**({'event':event} if event else {})})
 def test_exact_append_keeps_failed_answer_and_releases_only_unused_hold(self):
  result=self.call('reconcile_terminal',self.prior,self.event)
  self.assertEqual(result['snapshot']['eventCount'],22)
  self.assertEqual(result['snapshot']['knownSettledCostMicros'],12_133_883)
  self.assertEqual(result['snapshot']['remainingReservationMicros'],17_866_117)
  self.assertIsNone(result['snapshot']['activeRun'])
  row=result['snapshot']['runs']['01:'+PROOF['captureRunId']]
  self.assertFalse(row['captureAuthority']);self.assertEqual(row['captureStatus'],'CAPTURE_UNCERTAIN')
  self.assertEqual(row['answerGrade'],'NOT_EVALUATED')
  actual=(self.root/'fresh-spend.jsonl').read_bytes();self.assertTrue(actual.startswith(WIRE))
  self.assertEqual(json.loads(actual.splitlines()[-1])['event'],'terminal_cost_reconciled')
  self.assertEqual(self.call('read',result)['snapshot'],result['snapshot'])
  # Existing next-family accounting works without reusing this run or changing limits.
  new={'kind':'reserve','caseId':'20','captureRunId':str(uuid.uuid4()),'reservationId':str(uuid.uuid4()),'ceilingMicros':15_000_000}
  next_state=self.call('reserve',result,new)
  self.assertEqual(next_state['snapshot']['remainingReservationMicros'],2_866_117)
 def test_proof_tamper_fake_pass_scope_cost_and_extra_fields_never_append(self):
  changes=[('chargedCostMicros',0),('captureAuthority',True),('answerGrade','PASS'),('captureStatus','CAPTURE_COMPLETE'),
   ('pendingProviderAttempts',1),('observedAtMs',PROOF['providerDeadlineAtMs']-1),('ledgerSha256','a'*64),('unexpected',True)]
  for k,v in changes:
   event=copy.deepcopy(self.event);event['proof'][k]=v
   with self.subTest(k=k),self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,event)
  for k,v in [('caseId','20'),('reservationId',str(uuid.uuid4())),('kind','settle'),('extra',True)]:
   with self.subTest(k=k),self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,{**self.event,k:v})
  self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),WIRE)
 def test_repeat_stale_checkpoint_adopt_and_reused_run_rejected(self):
  done=self.call('reconcile_terminal',self.prior,self.event)
  for op,state,event in [('reconcile_terminal',self.prior,self.event),('reconcile_terminal',done,self.event),('read',self.prior,None),('adopt',None,None)]:
   with self.subTest(op=op),self.assertRaises(ValueError):self.call(op,state,event)
  with self.assertRaises(ValueError):self.call('reserve',done,{'kind':'reserve',**{k:PROOF[k] for k in ('caseId','captureRunId','reservationId')},'ceilingMicros':15_000_000})
 def test_interrupted_append_keeps_prefix_and_fails_closed(self):
  native=G['native'];original=native['Write'];calls=0
  def partial(handle,buffer,size,count,overlapped):
   nonlocal calls
   calls+=1
   if calls>1:raise OSError('test interrupted append')
   return original(handle,buffer,size//2,count,overlapped)
  native['Write']=partial
  try:
   with self.assertRaises(OSError):self.call('reconcile_terminal',self.prior,self.event)
  finally:native['Write']=original
  self.assertTrue((self.root/'fresh-spend.jsonl').read_bytes().startswith(WIRE))
  with self.assertRaises(ValueError):self.call('read',self.prior)
 def test_competing_native_writer_excludes_terminal_append(self):
  script="""import runpy,sys,contextlib
m=runpy.run_path(sys.argv[1]);n=m['native'];d,parts=m['protocol']['components'](sys.argv[2],root=True)
with contextlib.ExitStack() as s:
 p=s.enter_context(n['open_volume'](d))
 for part in parts:p=s.enter_context(n['open_child'](p,part,True))
 h=s.enter_context(n['open_child'](p,'fresh-spend.jsonl',False,write=True))
 print('LOCKED',flush=True);sys.stdin.readline()
"""
  child=subprocess.Popen([sys.executable,'-I','-c',script,str(BASE.parent/'lib/windows-capture-spend.py'),str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   self.assertEqual(child.stdout.readline().strip(),'LOCKED')
   with self.assertRaises(OSError):self.call('reconcile_terminal',self.prior,self.event)
  finally:child.communicate('\n',timeout=10)
  self.assertEqual(child.returncode,0);self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),WIRE)

if __name__=='__main__':unittest.main(verbosity=2)
