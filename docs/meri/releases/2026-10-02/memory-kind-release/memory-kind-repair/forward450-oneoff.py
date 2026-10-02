"""Fixed root-only forward450 Prisma task. Import and offline tests perform no AWS calls."""
import argparse, copy, hashlib, importlib.util, json, pathlib, re

ROOT=pathlib.Path(__file__).resolve().parent
BASE=ROOT.parent/'oct02-case01-release'/'case01-oneoff.py'
BASE_SHA='4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
OLD_ADAPTER=ROOT.parent/'oct02-release-path'/'synthetic-canary-codebuild.py'
OLD_SHA='02098e0d9209f7313a66c4e73eb0689332af2edd7ba2a2ecf6e6daa58b0671f6'
NEW_ADAPTER=ROOT/'synthetic-canary-codebuild-450.py'
SCRIPT=ROOT/'forward450-runner.mjs'
INPUT=ROOT/'forward450-input.json'
MODE='forward450-deploy'
FAMILY='capiro-dev-meri-forward450'
CONTAINER='meri-forward450'
VARIABLE='MERI_FORWARD450_INPUT'
PREFIX='MERI_FORWARD450_RECEIPT '
MIGRATE_TD='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api-migrate:135'
LIVE_TD='arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:505'
MIGRATION='20281005010000_memory_version_candidate_source_kinds'
MIGRATION_SHA='a8be392c1de78038b1fc584e5a2293183d736f7732890737402833c864e2c6ce'
CHECKS=('memory_candidate_source_kind_chk','memory_candidate_version_payload_check')
CLAIMS=('case01ExecutionSetup','case01ExecutionSetupRecovery','case01ExecutionSetupContinuation','case01ExecutionSetupPostApproval')

def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def load_operator():
    if hashlib.sha256(BASE.read_bytes()).hexdigest()!=BASE_SHA:raise RuntimeError('BASE_CHANGED')
    m=load(BASE,'forward450_base')
    old=OLD_ADAPTER.read_bytes()
    m.need(m.sha(old)==OLD_SHA and old.count(b'EXACT_449_IMAGE_MIGRATION_HASHES_PASS')==1,'OLD_ADAPTER_CHANGED')
    expected=old.replace(b'EXACT_449_IMAGE_MIGRATION_HASHES_PASS',b'EXACT_450_IMAGE_MIGRATION_HASHES_PASS')
    m.need(NEW_ADAPTER.read_bytes()==expected,'450_ADAPTER_NOT_EXACT_MARKER_DELTA')
    original_snapshot,original_source=m.snapshot,m.source_check
    a449=load(OLD_ADAPTER,'forward450_original449_adapter')
    m.ROOT=ROOT;m.__file__=__file__;m.ADAPTER=NEW_ADAPTER;m.ADAPTER_SHA=m.sha(expected)
    m.FAMILY=FAMILY;m.CONTAINER=CONTAINER;m.MODES={MODE:('node','fixed-migrate',VARIABLE)}
    bound_input_hash=None

    def parsed(data):
        def pairs(items):
            value={}
            for key,item in items:
                m.need(key not in value,'DUPLICATE_JSON_KEY');value[key]=item
            return value
        return json.loads(data.decode('utf-8-sig'),object_pairs_hook=pairs)

    def proof_input(path,expected_hash):
        data=pathlib.Path(path).read_bytes();m.need(m.sha(data)==expected_hash,'PROOF_CHANGED')
        value=parsed(data)
        m.need(value.get('version')==1 and value.get('kind')=='meri-forward450-qualified-candidate' and value.get('status')=='READY','FORWARD450_UNSEALED')
        m.need(value.get('migrationTaskDefinition')==MIGRATE_TD and value.get('servedTaskDefinition')==LIVE_TD,'FIXED_RUNTIME_BASELINE')
        for name in ('runnerSha256','inputSha256','migrationTaskDefinitionSha256'):
            m.need(isinstance(value.get(name),str) and re.fullmatch(r'[a-f0-9]{64}',value[name]),'REVIEW_PIN_REQUIRED')
        m.need(m.file_sha(SCRIPT)==value['runnerSha256'] and m.file_sha(INPUT)==value['inputSha256'],'REVIEWED_SOURCE_INPUT_CHANGED')
        return value

    def input_binding(mode,path,expected_hash):
        nonlocal bound_input_hash
        m.need(mode==MODE and pathlib.Path(path).resolve()==INPUT,'FIXED_INPUT_REQUIRED')
        data=INPUT.read_bytes();m.need(m.sha(data)==expected_hash,'INPUT_CHANGED')
        m.need(bound_input_hash is None or bound_input_hash==expected_hash,'INPUT_REBIND_REFUSED')
        bound_input_hash=expected_hash
        value=parsed(data)
        m.sanitize(value)
        m.need(set(value)=={'version','sourceSha','migrationSha256','manifestSha256','beforeCheckSha256','afterCheckSha256','claimSha256'},'FIXED_INPUT_FIELDS')
        m.need(value['version']==1 and re.fullmatch(r'[a-f0-9]{40}',value['sourceSha']) and value['migrationSha256']==MIGRATION_SHA,'FIXED_MIGRATION_INPUT')
        for key,names in [('beforeCheckSha256',CHECKS),('afterCheckSha256',CHECKS),('claimSha256',CLAIMS)]:
            m.need(set(value[key])==set(names) and all(re.fullmatch(r'[a-f0-9]{64}',v) for v in value[key].values()),'CATALOG_OR_CLAIM_PINS')
        m.need(re.fullmatch(r'[a-f0-9]{64}',value['manifestSha256']),'MANIFEST_PIN')
        text=m.canonical(value);m.need(len(text.encode())<=6000,'INPUT_LIMIT')
        overrides={'containerOverrides':[{'name':CONTAINER,'command':[],'environment':[{'name':VARIABLE,'value':text}]}]}
        m.need(len(m.canonical(overrides).encode())<=8192,'OVERRIDE_LIMIT')
        return value,overrides

    def qualify(a,repo,aws,proof_file,proof_hash):
        document=proof_input(proof_file,proof_hash)
        candidate,served=document['candidate'],document['served']
        head=original_source(a,repo,candidate.get('sourceSha'));aws.identity(m.CALLER)
        proof=a.qualify_build(aws,repo,'api',candidate)
        previous=a449.qualify_build(aws,repo,'api',served)
        value,_=input_binding(MODE,INPUT,document['inputSha256'])
        m.need(value['sourceSha']==proof['sourceSha'] and previous['sourceSha']!=proof['sourceSha'],'CANDIDATE_SERVED_SEPARATION')
        sql=a.git(repo,'show',proof['sourceSha']+':apps/api/prisma/migrations/'+MIGRATION+'/migration.sql')
        m.need(m.sha(sql)==MIGRATION_SHA,'CANDIDATE_SQL_CHANGED')
        return dict(proof,operatorHead=head,servedProof=previous,reviewed=document)

    def snapshot(a,helper,aws,proof):
        snap=original_snapshot(a,helper,aws,proof['servedProof'])
        m.need(snap['safe']['taskDefinition']==LIVE_TD,'SERVED_BASELINE_CHANGED')
        response=aws.definition(MIGRATE_TD);definition=helper.task_registration_request(response)
        m.need(m.digest(m.definition_projection(a,definition))==proof['reviewed']['migrationTaskDefinitionSha256'],'MIGRATION_TEMPLATE_CHANGED')
        m.need(response['taskDefinition']['taskDefinitionArn']==MIGRATE_TD,'MIGRATION_TEMPLATE_ID')
        for name in ('taskRoleArn','executionRoleArn','networkMode','requiresCompatibilities','runtimePlatform'):
            m.need(definition.get(name)==snap['definition'].get(name),'MIGRATION_RUNTIME_ROLE_DRIFT')
        m.need(len(definition.get('containerDefinitions',[]))==1,'MIGRATION_CONTAINER_AMBIGUOUS')
        container=definition['containerDefinitions'][0]
        m.need(container.get('command')==['migrate'] and not container.get('environmentFiles'),'APPROVED_MIGRATION_TEMPLATE_REQUIRED')
        snap['migrationDefinition']=definition;snap['migrationContainer']=container
        snap['safe'].update(servedSourceSha=proof['servedProof']['sourceSha'],servedImageDigest=proof['servedProof']['imageDigest'],
          migrationTaskDefinition=MIGRATE_TD,migrationTaskDefinitionHash=proof['reviewed']['migrationTaskDefinitionSha256'])
        return snap

    def task_request(a,snap,proof,mode):
        m.need(mode==MODE,'FIXED_MODE')
        api=snap['container'];template=snap['migrationContainer'];original=snap['migrationDefinition']
        env,refs=a.unique(template.get('environment'),'value'),a.unique(template.get('secrets'),'valueFrom')
        api_env,api_refs=a.unique(api.get('environment'),'value'),a.unique(api.get('secrets'),'valueFrom')
        m.need(m.DB_REFS<=set(refs) and not(m.DB_REFS&set(env)) and not(set(env)&set(refs)),'MIGRATION_DATABASE_REFS')
        m.need(env.get('DB_NAME')==api_env.get('DB_NAME') and bool(env.get('DB_NAME')),'DATABASE_NAME_CHANGED')
        m.need(all(refs[k]==api_refs[k] for k in ('DB_HOST','DB_PORT')),'DATABASE_ENDPOINT_CHANGED')
        m.need(refs['DB_USER']!=api_refs['DB_USER'] and refs['DB_PASSWORD']!=api_refs['DB_PASSWORD'],'MIGRATION_ROLE_REQUIRED')
        fields=('taskRoleArn','executionRoleArn','networkMode','requiresCompatibilities','cpu','memory','runtimePlatform')
        m.need(all(k in original for k in fields) and original['runtimePlatform'].get('cpuArchitecture')=='ARM64','MIGRATION_PLATFORM')
        logs=copy.deepcopy(api.get('logConfiguration'));m.need(logs and logs.get('logDriver')=='awslogs','CURRENT_LOGS_REQUIRED')
        m.need(logs.get('options',{}).get('awslogs-region')==m.REGION,'LOG_REGION')
        script=SCRIPT.read_bytes();m.need(m.sha(script)==proof['reviewed']['runnerSha256'],'RUNNER_CHANGED')
        result={k:copy.deepcopy(original[k]) for k in fields}
        result.update(family=FAMILY,containerDefinitions=[{'name':CONTAINER,'image':proof['image'],'essential':True,
          'entryPoint':['node','--input-type=module','--eval',script.decode()], 'command':[],
          'environment':[{'name':'DB_NAME','value':env['DB_NAME']},{'name':'GIT_SHA','value':proof['sourceSha']},{'name':'RELEASE_SHA','value':proof['sourceSha']},{'name':'TMPDIR','value':'/dev/shm'}],
          'secrets':[{'name':k,'valueFrom':refs[k]} for k in sorted(m.DB_REFS)],'logConfiguration':logs,
          'dockerLabels':{'org.opencontainers.image.revision':proof['sourceSha'],'org.opencontainers.image.source':a.REPOSITORY}}])
        return result

    def owner_receipts(messages,mode,require_success=True):
        m.need(mode==MODE and bound_input_hash is not None,'FIXED_INPUT_REQUIRED');value,_=input_binding(MODE,INPUT,bound_input_hash);entries=[]
        for message in messages:
            for line in message.splitlines():
                if not line.startswith(PREFIX):continue
                m.need(len(line.encode())<=10000,'RECEIPT_SIZE');row=json.loads(line[len(PREFIX):]);m.sanitize(row)
                m.need(row.get('version')==1 and row.get('kind')=='meri-forward450','FIXED_RECEIPT')
                if row.get('status') in ('BLOCKED','RECONCILIATION_REQUIRED'):
                    m.need(set(row)=={'version','kind','stage','status','code','prismaAttempted','retryAllowed'} and row['retryAllowed'] is False,'FAILURE_FIELDS')
                    m.need(row['stage'] in ('INPUT','PREFLIGHT','PRISMA_DEPLOY','POSTCHECK') and type(row['prismaAttempted']) is bool and row['code'] in
                      ('23514','42883','42501','55P03','57014','40P01','40001','42P01','42703','P3009','P3018','ETIMEDOUT','ERR_ASSERTION','FORWARD450_REFUSED'),'FAILURE_ENUM')
                elif row.get('stage')=='PREFLIGHT':
                    m.need(set(row)=={'version','kind','stage','status','sourceSha','appliedCount','oldLedgerSha256','checks','claimSha256','tlsVerified'},'PREFLIGHT_FIELDS')
                    m.need(row['status']=='VERIFIED' and row['appliedCount']==449 and row['checks']==value['beforeCheckSha256'] and row['claimSha256']==value['claimSha256'] and row['tlsVerified'] is True,'PREFLIGHT_SCOPE')
                elif row.get('stage')=='PRISMA_DEPLOY':
                    m.need(set(row)=={'version','kind','stage','status','sourceSha','migrationSha256'} and row['status']=='INTENT' and row['migrationSha256']==MIGRATION_SHA,'DEPLOY_INTENT')
                elif row.get('stage')=='COMPLETE':
                    m.need(set(row)=={'version','kind','stage','status','sourceSha','appliedCount','newMigration','migrationSha256','manifestSha256','oldLedgerSha256','oldLedgerUnchanged','checks','claimSha256','prismaExitCode','prismaOutputSha256','fixtureClaimsUnchanged','tlsVerified'},'COMPLETE_FIELDS')
                    m.need(row['status']=='VERIFIED' and row['appliedCount']==450 and row['newMigration']==MIGRATION and row['migrationSha256']==MIGRATION_SHA and row['manifestSha256']==value['manifestSha256'] and row['checks']==value['afterCheckSha256'] and row['claimSha256']==value['claimSha256'] and row['prismaExitCode']==0 and all(row[k] is True for k in ('oldLedgerUnchanged','fixtureClaimsUnchanged','tlsVerified')),'COMPLETE_SCOPE')
                else:raise m.Refusal('UNEXPECTED_STAGE')
                if 'sourceSha' in row:m.need(row['sourceSha']==value['sourceSha'],'RECEIPT_SOURCE')
                for name in ('oldLedgerSha256','prismaOutputSha256'):
                    if name in row:m.need(isinstance(row[name],str) and re.fullmatch(r'[a-f0-9]{64}',row[name]),'RECEIPT_HASH')
                entries.append(row)
        m.need(len(entries)<=3,'RECEIPT_COUNT')
        if require_success:
            m.need([(r.get('stage'),r.get('status')) for r in entries]==[('PREFLIGHT','VERIFIED'),('PRISMA_DEPLOY','INTENT'),('COMPLETE','VERIFIED')],'MIGRATION_NOT_VERIFIED')
            m.need(entries[0]['oldLedgerSha256']==entries[2]['oldLedgerSha256'],'OLD_LEDGER_CHANGED')
        return entries

    m.input_binding=input_binding;m.qualify=qualify;m.snapshot=snapshot;m.task_request=task_request;m.owner_receipts=owner_receipts
    return m

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['prepare','run'])
    for name in ('repo','proof','proof-sha256','input-sha256','out'):parser.add_argument('--'+name,required=True)
    for name in ('plan','plan-sha256','confirm'):parser.add_argument('--'+name)
    args=parser.parse_args()
    try:
        m=load_operator();args.mode,args.input=MODE,str(INPUT)
        if args.action=='run':
            m.need(args.confirm=='RUN_ONE_FORWARD450_PRISMA_DEPLOY','CONFIRMATION_REQUIRED')
            # Fixed across all plans: no second DDL task after an ambiguous acknowledgement.
            m.create(ROOT/'forward450-operation-once.json',{'status':'CLAIMED','planHash':args.plan_sha256})
            args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
        a=m.adapter();helper,_=a.load_helpers(args.repo);aws=a.Aws('default')
        result=m.prepare(a,helper,aws,args) if args.action=='prepare' else m.run(a,helper,aws,args)
        print(json.dumps(result));return 0
    except Exception:
        print(json.dumps({'status':'BLOCKED','code':'FORWARD450_OPERATOR_REFUSED'}));return 1
if __name__=='__main__':raise SystemExit(main())
