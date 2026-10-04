from pathlib import Path
repo=Path('C:/dev/main/meri-c1-20261002/evals/meri/live-v1')
p=repo/'tests/case01-failed-receipt-cost.unit.py'
s=p.read_text()
s=s.replace("case01-failed-receipt-journal21.unit.jsonl","case20-terminal-cost-journal23.unit.jsonl")
s=s.replace("case01-failed-receipt-cost.unit.json","case20-terminal-cost.unit.json")
s=s.replace("case01-failed-receipt-cost-proof.unit.json","case20-terminal-cost-proof.unit.json")
s=s.replace("case01-terminal-cost-local-v1","cost-supervised-v1/ntfs-tests")
s=s.replace('PARENT.mkdir(exist_ok=True)','PARENT.mkdir(parents=True,exist_ok=True)')
s=s.replace('exact21 bytes','exact23 bytes')
s=s.replace("['eventCount'],22","['eventCount'],24")
s=s.replace("['knownSettledCostMicros'],12_133_883","['knownSettledCostMicros'],13_631_058")
s=s.replace("['remainingReservationMicros'],17_866_117","['remainingReservationMicros'],16_368_942")
s=s.replace("['01:'+PROOF['captureRunId']]","['20:'+PROOF['captureRunId']]")
s=s.replace("['remainingReservationMicros'],2_866_117","['remainingReservationMicros'],1_368_942")
s=s.replace("[('caseId','20')","[('caseId','01')")
# Native handle tests must reject same-byte replacement identity and altered prefix,
# including drift where an adversary also updates the caller-provided descriptor.
extra='''
 def test_prefix_drift_rejected_even_with_updated_descriptor(self):
  bad=WIRE.replace(b'"atMs":1791075178097',b'"atMs":1791075178098')
  self.assertNotEqual(bad,WIRE)
  (self.root/'fresh-spend.jsonl').write_bytes(bad)
  self.prior['state']['files']['fresh-spend.jsonl'].update(sha256=MODULE['digest'](bad),bytes=len(bad))
  with self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,self.event)
  self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),bad)
 def test_same_bytes_replaced_file_identity_rejected(self):
  journal=self.root/'fresh-spend.jsonl'
  journal.rename(self.root/'original-preserved.jsonl')
  journal.write_bytes(WIRE)
  with self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,self.event)
  self.assertEqual(journal.read_bytes(),WIRE)
 def test_authorization_content_drift_rejected(self):
  authorization=self.root/'run-authorization.json'
  authorization.write_bytes(AUTHORIZATION+b' ')
  with self.assertRaises(ValueError):self.call('reconcile_terminal',self.prior,self.event)
  self.assertEqual((self.root/'fresh-spend.jsonl').read_bytes(),WIRE)
'''
s=s.replace("if __name__=='__main__'",extra+"\nif __name__=='__main__'")
(repo/'tests/case20-terminal-cost.unit.py').write_text(s,newline='\n')
