import copy,importlib.util,json,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('diag',ROOT/'forward450-diagnostic-oneoff.py');d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
class Tests(unittest.TestCase):
 def setUp(self):
  self.m=d.load_operator()
  self.row={'version':1,'kind':'meri-forward450-readonly-diagnostic','status':'READBACK_COMPLETE','sourceSha':'42988dae5fb7bc2fff3af582ca15a0836a4477c5','readOnly':True,'mutations':0,'prismaAttempted':False,'tlsVerified':True,
   'ledger':{'total':606,'activeFinished':506,'rolledBack':100,'unfinished':0,'apiExpected':449,'apiExact':388,'apiHistorical':61,'newMigrationRows':0,'oldLedgerSha256':'a'*64,'missingApiNames':[],'ambiguousApiNames':[],'historicalChecksumDifferences':[{'name':'migration_old','sourceSha256':'b'*64,'appliedSha256':'c'*64}],'outsideApiActive':[{'name':'workspace_old','checksum':'d'*64}]},
   'checks':[{'name':n,'validated':True,'definitionSha256':'e'*64,'expectedMatch':True} for n in ['memory_candidate_source_kind_chk','memory_candidate_version_payload_check']],
   'claimSha256':dict.fromkeys(['case01ExecutionSetup','case01ExecutionSetupRecovery','case01ExecutionSetupContinuation','case01ExecutionSetupPostApproval'],'f'*64),'otherRelationLocks':0,
   'guards':dict.fromkeys('fresh449Exact allApiNamesPresent newMigrationAbsent noUnfinished checksMatch fixtureNamespaceMatches fixtureClaimsMatch migrationOwnsTables noOtherRelationLocks'.split(),True)}
  self.row['guards']['fresh449Exact']=False
 def parse(self,row):return self.m.owner_receipts(['raw provider log ignored',d.PREFIX+json.dumps(row)],d.MODE)
 def test_exact_historical_metadata_survives_original_sanitizer(self):self.assertEqual(self.parse(self.row),[self.row])
 def test_mutation_source_or_extra_fields_refused(self):
  for k,v in [('prismaAttempted',True),('mutations',1),('readOnly',False),('sourceSha','a'*40),('rawMessage','unapproved')]:
   row=copy.deepcopy(self.row);row[k]=v
   with self.assertRaises(self.m.Refusal):self.parse(row)
 def test_sensitive_field_and_arbitrary_migration_name_refused(self):
  row=copy.deepcopy(self.row);row['password']='never-log'
  with self.assertRaises(self.m.Refusal):self.parse(row)
  row=copy.deepcopy(self.row);row['ledger']['outsideApiActive'][0]['name']='bad newline\n'
  with self.assertRaises(self.m.Refusal):self.parse(row)
 def test_failed_diagnostic_partial_never_green(self):
  row={'version':1,'kind':'meri-forward450-readonly-diagnostic','status':'BLOCKED','stage':'READ_ONLY','code':'57014','readOnly':True,'mutations':0,'prismaAttempted':False}
  logs=[d.PREFIX+json.dumps(row)]
  self.assertEqual(self.m.owner_receipts(logs,d.MODE,False),[row])
  with self.assertRaises(self.m.Refusal):self.parse(row)
 def test_fixed_input_only_changes_readonly_environment_and_no_prisma_child(self):
  value,overrides=self.m.input_binding(d.MODE,ROOT/'forward450-input.json',self.m.file_sha(ROOT/'forward450-input.json'))
  self.assertEqual(overrides['containerOverrides'][0]['command'],[])
  self.assertEqual(overrides['containerOverrides'][0]['name'],'meri-forward450-readonly')
  self.assertEqual(overrides['containerOverrides'][0]['environment'][0]['name'],'MERI_FORWARD450_DIAGNOSTIC_INPUT')
  source=(ROOT/'forward450-diagnostic.mjs').read_text()
  for prohibited in ['spawnSync','writeFileSync',"require.resolve('prisma')",'migrate deploy','COMMIT\')']:
   self.assertNotIn(prohibited,source)
if __name__=='__main__':unittest.main()
