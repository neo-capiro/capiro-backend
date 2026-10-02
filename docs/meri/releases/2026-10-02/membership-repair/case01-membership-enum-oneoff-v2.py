"""One fixed type-only case01 diagnosis; reuses frozen one-off lifecycle, no approval."""
import argparse, hashlib, importlib.util, json, pathlib, re

ROOT=pathlib.Path(__file__).resolve().parent
BASE=ROOT/'case01-oneoff.py'
BASE_SHA='4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
SCRIPT=ROOT/'case01-membership-enum-readonly-v2.mjs'
SCRIPT_SHA='e05d626bf82746d2bc81a10458a36cad559b0a348d16635fab685f4530260fcc'
INPUT=ROOT/'setup-execute-input.json'
INPUT_SHA='2abd45698d1ca98629e060178b702a21bfe0c7c56ec790258f6e1653aab5ab8c'
FAILED=ROOT/'case01-recovery-execute-execution.json'
FAILED_SHA='9ac310b1ed66877cdb9e3fb3a444e955c4fa067b0436ed401951441a541d45c7'
PRIOR_QUERY=ROOT/'case01-membership-enum-execution.json'
PRIOR_QUERY_SHA='11fce0d22d986259a8324f2cac1cd33585fadcda270622c456e3a5ea87034b24'
SOURCE='c22d059e4fc8fd73f93e6928f7db3a1a4338f7f8'
MODE='membership-enum-read'
FAMILY='capiro-dev-meri-case01-enum-reconcile'
CONTAINER='meri-case01-enum-reconcile'
VARIABLE='MERI_CASE01_ENUM_INPUT'
PREFIX='MERI_CASE01_ENUM_RECEIPT '
RUN='c6ffa5ad-dd9f-4912-bc31-a03231a9b903'
RECIPE='29cc20de9afb70ec31e009afd0b7c3226482f1372b05d2ccec7e86a835ec0142'
ORIGINAL='5fdd382ee4332c3723f801d060c1462b9f4082e5a86fd945c7900fbba25be588'
RECOVERY='2d51c9ef4f90dbc9bd5e2a98c30c1e70dde09386fb5e6857b0ebb4f2c08d0bc9'

def load_operator():
    if hashlib.sha256(BASE.read_bytes()).hexdigest()!=BASE_SHA: raise RuntimeError('REVIEWED_BASE_CHANGED')
    spec=importlib.util.spec_from_file_location('fixed_enum_base',BASE)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    old_source,old_request,old_qualify=m.source_check,m.task_request,m.qualify
    m.__file__=__file__;m.FAMILY,m.CONTAINER=FAMILY,CONTAINER
    m.MODES={MODE:('node','read-only',VARIABLE)}

    def parsed(data):
        def pairs(items):
            result={}
            for key,value in items:
                m.need(key not in result,'DUPLICATE_JSON_KEY');result[key]=value
            return result
        return json.loads(data.decode('utf-8-sig'),object_pairs_hook=pairs)

    def fixed_files():
        # Hash and parse the same captured bytes, including the inline script.
        values={}
        for name,path,expected in [('base',BASE,BASE_SHA),('script',SCRIPT,SCRIPT_SHA),('input',INPUT,INPUT_SHA),('failure',FAILED,FAILED_SHA),('prior_query',PRIOR_QUERY,PRIOR_QUERY_SHA)]:
            data=path.read_bytes();m.need(m.sha(data)==expected,'FIXED_'+name.upper()+'_CHANGED');values[name]=data
        inp,failed=parsed(values['input']),parsed(values['failure'])
        prior=parsed(values['prior_query'])
        m.need(prior.get('status')=='RECONCILIATION_REQUIRED' and prior.get('mode')==MODE
               and prior.get('sourceSha')==SOURCE and prior.get('containerExitCode')==1
               and prior.get('taskArn')=='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/e9659e09b5994a6d82a6874c250e19c8'
               and prior.get('ownerReceipts')==[{'kind':'meri-case01-membership-enum-readback','schemaVersion':1,'status':'READBACK_FAILED','readOnly':True,'mutations':0,'liveAcceptance':'NOT_RUN','stage':'COLUMN_TYPE','code':'ERR_ASSERTION'}],'PRIOR_QUERY_FAILURE_CHANGED')
        m.need(m.digest(inp.get('recipe'))==RECIPE,'FIXED_RECIPE_CHANGED')
        m.need(failed.get('status')=='RECONCILIATION_REQUIRED' and failed.get('mode')=='setup-recovery-execute'
               and failed.get('sourceSha')==SOURCE and failed.get('containerExitCode')==1
               and failed.get('taskArn')=='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/d2654fa526ac45d6843a6234d993074a','FAILED_TASK_SCOPE')
        entries=failed.get('ownerReceipts',[])
        m.need(len(entries)==4 and entries[1].get('stage')=='RECOVERY_ADMISSION' and entries[1].get('phase')=='VERIFIED'
               and entries[1].get('claimSha256')==RECOVERY and entries[-1].get('stage')=='FIRST_CANONICAL_APPROVAL'
               and entries[-1].get('phase')=='RECONCILIATION_REQUIRED'
               and entries[-1].get('failure')=={'stage':'FIRST_CANONICAL_APPROVAL','errorClass':'PrismaClientKnownRequestError','prismaCode':'P2010','sqlState':None},'FAILED_OWNER_SCOPE')
        return inp,values['script'].decode('utf-8-sig')

    def source_check(a,repo,source_sha):
        fixed_files();m.need(source_sha==SOURCE,'FIXED_IMAGE_SOURCE_REQUIRED')
        return old_source(a,repo,source_sha)

    def input_binding(mode,path,expected_hash):
        value,_=fixed_files();m.need(mode==MODE and pathlib.Path(path).resolve()==INPUT and expected_hash==INPUT_SHA,'FIXED_INPUT_ONLY')
        m.sanitize(value);text=m.canonical(value)
        m.need(0<len(text.encode())<=6000,'INPUT_BYTE_LIMIT')
        overrides={'containerOverrides':[{'name':CONTAINER,'command':[],'environment':[{'name':VARIABLE,'value':text}]}]}
        m.need(len(m.canonical(overrides).encode())<=8192,'ECS_OVERRIDE_BYTE_LIMIT')
        return value,overrides

    def task_request(a,snap,proof,mode):
        _,script=fixed_files();m.need(mode==MODE and proof.get('sourceSha')==SOURCE,'FIXED_DIAGNOSTIC_ONLY')
        request=old_request(a,snap,proof,mode);container=request['containerDefinitions'][0]
        m.need({entry['name'] for entry in container['secrets']}==m.DB_REFS,'DATABASE_REFERENCES_ONLY')
        env=a.unique(snap['container'].get('environment'),'value')
        names={'DB_NAME','GIT_SHA','RELEASE_SHA'};m.need(names<=set(env),'DIAGNOSTIC_ENVIRONMENT_MISSING')
        container['environment']=[{'name':name,'value':env[name]} for name in sorted(names)]+[{'name':'TMPDIR','value':'/dev/shm'}]
        container['entryPoint']=['node','--input-type=module','--eval',script];container['command']=[]
        return request

    def owner_receipts(messages,mode,require_success=True):
        m.need(mode==MODE,'FIXED_DIAGNOSTIC_ONLY');entries=[]
        _,script=fixed_files()
        sql=re.search(r'const MEMBERSHIP_SQL = "([^"\n]+)";',script).group(1)
        comparison={'parameterType':'text','method':'EXPLAIN_WITHOUT_ANALYZE','original':{'planned':False,'sqlState':'42883'},'fixed':{'planned':True},
                    'originalSqlSha256':m.sha(sql.encode()),'fixedSqlSha256':m.sha(sql.replace('AND role=$3::text','AND role::text=$3::text').encode())}
        common={'kind','schemaVersion','status','readOnly','mutations','liveAcceptance'}
        for message in messages:
            for line in message.splitlines():
                if not line.startswith(PREFIX):continue
                m.need(len(line.encode())<=20000,'RECEIPT_SIZE');entry=parsed(line[len(PREFIX):].encode());m.sanitize(entry)
                m.need(entry.get('kind')=='meri-case01-membership-enum-readback' and entry.get('schemaVersion')==1
                       and entry.get('readOnly') is True and entry.get('mutations')==0 and entry.get('liveAcceptance')=='NOT_RUN','READONLY_RECEIPT_SCOPE')
                if entry.get('status')=='READBACK_COMPLETE':
                    m.need(set(entry)==common|{'sourceSha','captureRunId','transport','roleColumn','comparison','ownedState'},'READBACK_FIELDS')
                    m.need(entry['sourceSha']==SOURCE and entry['captureRunId']==RUN,'READBACK_SOURCE_RUN')
                    m.need(entry['transport']=={'tlsVerified':True,'caBundleSha256':'b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77'},'TLS_INVALID')
                    m.need(entry['roleColumn']=={'name':'tenant_role','kind':'e','formatted':'tenant_role','labels':['capiro_admin','user_admin','standard_user','client_portal_user']},'ROLE_TYPE_INVALID')
                    m.need(entry['comparison']==comparison,'QUERY_PROOF_INVALID')
                    m.need(entry['ownedState']=={'originalClaimSha256':ORIGINAL,'recoveryClaimSha256':RECOVERY,
                       'candidate':{'id':'557b5b98-f591-50ce-83ea-2ca44d44567a','status':'pending','governed_status':'suggested','row_version':'113340385','no_projection':True,'no_item':True},
                       'locatorPresent':False,'bindingPresent':False},'OWNED_STATE_CHANGED')
                else:
                    m.need(entry.get('status')=='READBACK_FAILED' and set(entry)==common|{'stage','code'},'FAILURE_FIELDS')
                    m.need(entry['stage'] in {'INPUT','CONNECT','OWNED_STATE','COLUMN_TYPE','EXPLAIN'} and entry['code'] in {'42883','42501','42703','42P01','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ETIMEDOUT','ECONNREFUSED','ERR_ASSERTION','READBACK_REFUSED'},'SAFE_FAILURE_ONLY')
                entries.append(entry)
        m.need(len(entries)<=1,'RECEIPT_COUNT')
        if require_success:m.need(len(entries)==1 and entries[0]['status']=='READBACK_COMPLETE','READBACK_NOT_COMPLETE')
        return entries

    def qualify(a,repo,aws,proof_file,proof_hash):
        fixed_files();return old_qualify(a,repo,aws,proof_file,proof_hash)

    m.fixed_files=fixed_files;m.source_check=source_check;m.input_binding=input_binding;m.task_request=task_request
    m.owner_receipts=owner_receipts;m.qualify=qualify
    return m

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['prepare','run'])
    for name in ('repo','proof','proof-sha256','out'):parser.add_argument('--'+name,required=True)
    for name in ('plan','plan-sha256','confirm'):parser.add_argument('--'+name)
    args=parser.parse_args()
    try:
        m=load_operator();args.mode,args.input,args.input_sha256=MODE,str(INPUT),INPUT_SHA
        if args.action=='run':
            m.need(args.confirm=='RUN_ONE_READONLY_MEMBERSHIP_ENUM_PROBE','CONFIRMATION_REQUIRED');args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
        a=m.adapter();helper,_=a.load_helpers(args.repo);aws=a.Aws('default')
        result=m.prepare(a,helper,aws,args) if args.action=='prepare' else m.run(a,helper,aws,args)
        print(json.dumps(result));return 0
    except Exception:
        print(json.dumps({'status':'BLOCKED','code':'FIXED_ENUM_DIAGNOSTIC_REFUSED'}));return 1
if __name__=='__main__':raise SystemExit(main())

