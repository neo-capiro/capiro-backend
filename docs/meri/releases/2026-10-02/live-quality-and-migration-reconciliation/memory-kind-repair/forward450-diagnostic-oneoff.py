"""Fixed SELECT-only diagnosis after refused450 preflight; never deploys migrations."""
import argparse,hashlib,importlib.util,json,pathlib,re
ROOT=pathlib.Path(__file__).resolve().parent
BASE=ROOT/'forward450-oneoff.py'
BASE_SHA='03f5c2eb792a7cc9abd8aecf923268f6a5b1fc0989c4c68f1a47a5508dc8ae9f'
FAILED=ROOT/'forward450-execution.json'
FAILED_SHA='c69da8bdbeb8e7c6a2bdc82cce2566a9c5dbcbbdb54510f1e925f3b5a60117bc'
MODE='forward450-readonly-diagnostic'
PREFIX='MERI_FORWARD450_DIAGNOSTIC '
def load_operator():
 assert hashlib.sha256(BASE.read_bytes()).hexdigest()==BASE_SHA
 assert hashlib.sha256(FAILED.read_bytes()).hexdigest()==FAILED_SHA
 failure=json.loads(FAILED.read_bytes());assert failure['containerExitCode']==1 and failure['ownerReceipts']==[{'version':1,'kind':'meri-forward450','stage':'PREFLIGHT','status':'BLOCKED','code':'ERR_ASSERTION','prismaAttempted':False,'retryAllowed':False}]
 spec=importlib.util.spec_from_file_location('readonly450_base',BASE);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
 w.__file__=__file__;w.MODE=MODE;w.SCRIPT=ROOT/'forward450-diagnostic.mjs';w.VARIABLE='MERI_FORWARD450_DIAGNOSTIC_INPUT';w.FAMILY='capiro-dev-meri-forward450-readonly';w.CONTAINER='meri-forward450-readonly'
 m=w.load_operator();original_qualify=m.qualify
 def owner_receipts(messages,mode,require_success=True):
  m.need(mode==MODE,'FIXED_READONLY_MODE');rows=[]
  for message in messages:
   for line in message.splitlines():
    if not line.startswith(PREFIX):continue
    m.need(len(line.encode())<=60000,'DIAGNOSTIC_SIZE');r=json.loads(line[len(PREFIX):]);m.sanitize(r)
    m.need(r.get('version')==1 and r.get('kind')=='meri-forward450-readonly-diagnostic' and r.get('readOnly') is True and r.get('mutations')==0 and r.get('prismaAttempted') is False,'READONLY_SCOPE')
    if r.get('status')=='BLOCKED':
     m.need(set(r)=={'version','kind','status','stage','code','readOnly','mutations','prismaAttempted'} and r['stage'] in ('INPUT','CONNECT','READ_ONLY') and r['code'] in ('42501','55P03','57014','42P01','42703','ERR_ASSERTION','READONLY_REFUSED'),'FAILURE_SCOPE')
    else:
     m.need(set(r)=={'version','kind','status','sourceSha','readOnly','mutations','prismaAttempted','tlsVerified','ledger','checks','claimSha256','otherRelationLocks','guards'},'READBACK_FIELDS')
     m.need(r['status']=='READBACK_COMPLETE' and r['sourceSha']==failure['sourceSha'] and r['tlsVerified'] is True,'READBACK_SOURCE')
     ledger=r['ledger'];count_fields=('total','activeFinished','rolledBack','unfinished','apiExpected','apiExact','apiHistorical','newMigrationRows')
     m.need(set(ledger)==set(count_fields)|{'oldLedgerSha256','missingApiNames','ambiguousApiNames','historicalChecksumDifferences','outsideApiActive'},'LEDGER_FIELDS')
     m.need(all(type(ledger[k]) is int and 0<=ledger[k]<=10000 for k in count_fields) and ledger['apiExpected']==449,'LEDGER_COUNTS')
     m.need(re.fullmatch('[a-f0-9]{64}',ledger['oldLedgerSha256']),'LEDGER_HASH')
     for key in ('missingApiNames','ambiguousApiNames'):
      m.need(isinstance(ledger[key],list) and len(ledger[key])<=449 and all(isinstance(n,str) and re.fullmatch('[A-Za-z0-9_-]{1,200}',n) for n in ledger[key]),'MIGRATION_IDENTITIES')
     for key,fields in [('historicalChecksumDifferences',{'name','sourceSha256','appliedSha256'}),('outsideApiActive',{'name','checksum'})]:
      m.need(isinstance(ledger[key],list) and len(ledger[key])<=1000,'MIGRATION_ROW_LIMIT')
      for row in ledger[key]:m.need(set(row)==fields and re.fullmatch('[A-Za-z0-9_-]{1,200}',row['name']) and all(re.fullmatch('[a-f0-9]{64}',row[k]) for k in fields-{'name'}),'MIGRATION_METADATA')
     m.need(len(r['checks'])==2 and {x['name'] for x in r['checks']}==set(w.CHECKS),'CATALOG_NAMES')
     for row in r['checks']:m.need(set(row)=={'name','validated','definitionSha256','expectedMatch'} and type(row['validated']) is bool and type(row['expectedMatch']) is bool and re.fullmatch('[a-f0-9]{64}',row['definitionSha256']),'CATALOG_METADATA')
     m.need(set(r['claimSha256'])==set(w.CLAIMS) and all(v is None or re.fullmatch('[a-f0-9]{64}',v) for v in r['claimSha256'].values()),'CLAIM_METADATA')
     m.need(set(r['guards'])==set('fresh449Exact allApiNamesPresent newMigrationAbsent noUnfinished checksMatch fixtureNamespaceMatches fixtureClaimsMatch migrationOwnsTables noOtherRelationLocks'.split()) and all(type(v) is bool for v in r['guards'].values()),'GUARD_METADATA')
     m.need(type(r['otherRelationLocks']) is int and 0<=r['otherRelationLocks']<=100000,'LOCK_METADATA')
    rows.append(r)
  m.need(len(rows)<=1,'READBACK_COUNT')
  if require_success:m.need(len(rows)==1 and rows[0]['status']=='READBACK_COMPLETE','READBACK_NOT_COMPLETE')
  return rows
 def qualify(a,repo,aws,proof_file,proof_hash):
  proof=original_qualify(a,repo,aws,proof_file,proof_hash)
  # Re-establish the exact failed task before authorizing this SELECT-only task.
  plan=m.read_json(ROOT/'forward450-task-plan.json');body=dict(plan);claimed=body.pop('planHash')
  m.need(m.digest(body)==claimed==failure['planHash'],'FAILED_PLAN_CHANGED')
  original=w.load(BASE,'original_failed_forward450');prior=original.load_operator()
  _,overrides=prior.input_binding(original.MODE,original.INPUT,plan['inputSha256'])
  tasks=aws.tasks([failure['taskArn']]);m.need(len(tasks)==1,'FAILED_TASK_MISSING')
  container=prior.task_identity(tasks[0],failure['taskArn'],failure['taskDefinition'],overrides,plan['imageDigest'])
  m.need(tasks[0]['lastStatus']=='STOPPED' and container['exitCode']==1 and proof['imageDigest']==plan['imageDigest'],'FAILED_TASK_CHANGED')
  helper,_=a.load_helpers(repo);request=helper.task_registration_request(aws.definition(failure['taskDefinition']))
  m.need(m.digest(m.definition_projection(a,request))==plan['oneOffDefinitionHash'],'FAILED_DEFINITION_CHANGED')
  opts=request['containerDefinitions'][0]['logConfiguration']['options'];stream=opts['awslogs-stream-prefix']+'/'+original.CONTAINER+'/'+failure['taskArn'].rsplit('/',1)[1]
  m.need(prior.owner_receipts(aws.logs(opts['awslogs-group'],stream),original.MODE,False)==failure['ownerReceipts'],'FAILED_LOGS_CHANGED')
  return proof
 m.owner_receipts=owner_receipts;m.qualify=qualify
 return m
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['prepare','run'])
 for name in ('repo','proof','proof-sha256','input-sha256','out'):parser.add_argument('--'+name,required=True)
 for name in ('plan','plan-sha256','confirm'):parser.add_argument('--'+name)
 args=parser.parse_args()
 try:
  m=load_operator();args.mode=MODE;args.input=str(ROOT/'forward450-input.json')
  expected=ROOT/('forward450-diagnostic-task-plan.json' if args.action=='prepare' else 'forward450-diagnostic-execution.json')
  m.need(pathlib.Path(args.out).resolve()==expected,'FIXED_OUTPUT')
  if args.action=='run':
   m.need(args.confirm=='RUN_ONE_READONLY_FORWARD450_DIAGNOSTIC' and pathlib.Path(args.plan).resolve()==ROOT/'forward450-diagnostic-task-plan.json','FIXED_READONLY_CONFIRMATION')
   args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
  a=m.adapter();helper,_=a.load_helpers(args.repo);aws=a.Aws('default')
  print(json.dumps(m.prepare(a,helper,aws,args) if args.action=='prepare' else m.run(a,helper,aws,args)));return 0
 except Exception as e:
  print(json.dumps({'status':'BLOCKED','code':str(e) if 'm' in locals() and isinstance(e,m.Refusal) else 'READONLY_OPERATOR_REFUSED'}));return 1
if __name__=='__main__':raise SystemExit(main())
