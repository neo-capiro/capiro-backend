"""One fixed current-approval read-only diagnosis; no approval or projection execution."""
import argparse, hashlib, importlib.util, json, pathlib, re

ROOT=pathlib.Path(__file__).resolve().parent
BASE=ROOT/'case01-oneoff.py'
BASE_SHA='4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
SCRIPT=ROOT/'case01-projection-readonly.mjs'
SCRIPT_SHA='4a233fdde82cb5a5f7120ac55771db7a8d283408ff3cbcf4188a2935c24f4570'
INPUT=ROOT/'setup-execute-input.json'
INPUT_SHA='2abd45698d1ca98629e060178b702a21bfe0c7c56ec790258f6e1653aab5ab8c'
FAILED=ROOT/'case01-continuation-execute-execution.json'
FAILED_SHA='7684813edfc1448edaab208fd15caed578c001c01c45de1c8cf513844a4be733'
SOURCE='42780caa75fcabe4f83e619ad81c0f36fdda8fad'
MODE='projection-state-read'
FAMILY='capiro-dev-meri-case01-projection-reconcile'
CONTAINER='meri-case01-projection-reconcile'
VARIABLE='MERI_CASE01_PROJECTION_INPUT'
PREFIX='MERI_CASE01_PROJECTION_RECEIPT '
RUN='c6ffa5ad-dd9f-4912-bc31-a03231a9b903'
RECIPE='29cc20de9afb70ec31e009afd0b7c3226482f1372b05d2ccec7e86a835ec0142'
ORIGINAL='5fdd382ee4332c3723f801d060c1462b9f4082e5a86fd945c7900fbba25be588'
RECOVERY='2d51c9ef4f90dbc9bd5e2a98c30c1e70dde09386fb5e6857b0ebb4f2c08d0bc9'
CONTINUATION='28138f575b12c2d05a7f6ae5acc3496af9479eb4a4e29c0feab7a000dc2ef824'

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
        for name,path,expected in [('base',BASE,BASE_SHA),('script',SCRIPT,SCRIPT_SHA),('input',INPUT,INPUT_SHA),('failure',FAILED,FAILED_SHA)]:
            data=path.read_bytes();m.need(m.sha(data)==expected,'FIXED_'+name.upper()+'_CHANGED');values[name]=data
        inp,failed=parsed(values['input']),parsed(values['failure'])
        m.need(m.digest(inp.get('recipe'))==RECIPE,'FIXED_RECIPE_CHANGED')
        m.need(failed.get('status')=='RECONCILIATION_REQUIRED' and failed.get('mode')=='setup-continuation-execute'
               and failed.get('sourceSha')==SOURCE and failed.get('containerExitCode')==1
               and failed.get('taskArn')=='arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/fa59a06ba49b4366b7b7cc84ac91e959','FAILED_TASK_SCOPE')
        entries=failed.get('ownerReceipts',[])
        m.need(len(entries)==4 and entries[1].get('stage')=='CONTINUATION_ADMISSION' and entries[1].get('phase')=='VERIFIED'
               and entries[1].get('claimSha256')==CONTINUATION and entries[-1].get('stage')=='FIRST_CANONICAL_APPROVAL'
               and entries[-1].get('phase')=='RECONCILIATION_REQUIRED'
               and entries[-1].get('failure')=={'stage':'FIRST_CANONICAL_APPROVAL','errorClass':'Error','prismaCode':None,'sqlState':None},'FAILED_OWNER_SCOPE')
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

    def validate(value,shape):
        if isinstance(shape,dict):
            m.need(isinstance(value,dict) and set(value)==set(shape),'RECEIPT_FIELDS')
            for key,sub in shape.items():validate(value[key],sub)
        elif isinstance(shape,list):
            m.need(isinstance(value,list) and len(value)<=10,'BOUNDED_ROWS')
            for row in value:validate(row,shape[0])
        elif isinstance(shape,tuple):
            if shape[0]=='nullable':
                if value is not None:validate(value,shape[1])
            else:m.need(value in shape,'RECEIPT_ENUM')
        elif shape is bool:m.need(type(value) is bool,'BOOLEAN_REQUIRED')
        elif shape is int:m.need(type(value) is int and 0<=value<=1000000,'INTEGER_REQUIRED')
        elif shape=='UUID':m.need(isinstance(value,str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',value),'UUID_REQUIRED')
        elif shape=='HASH':m.need(isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value),'HASH_REQUIRED')
        elif shape=='WORD':m.need(isinstance(value,str) and re.fullmatch(r'[a-z_]{1,40}',value),'STATUS_REQUIRED')
        elif shape=='VERSION':m.need(isinstance(value,str) and re.fullmatch(r'[0-9]{1,20}',value),'ROW_VERSION_REQUIRED')
        elif shape=='DATE':m.need(isinstance(value,str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z',value),'DATE_REQUIRED')
        else:m.need(type(value) is type(shape) and value==shape,'FIXED_RECEIPT_VALUE')

    def owner_receipts(messages,mode,require_success=True):
        m.need(mode==MODE,'FIXED_DIAGNOSTIC_ONLY');entries=[]
        N=lambda value:('nullable',value)
        table=('clio_memory','context_embeddings','memory_cleanup_outbox','memory_items')
        query={'status':('READ','QUERY_FAILED'),'sqlState':N(('42501','22P02','42703','42P01')),'ids':['UUID']}
        shape={'kind':'meri-case01-projection-readback','schemaVersion':1,'status':'READBACK_COMPLETE','readOnly':True,'mutations':0,'liveAcceptance':'NOT_RUN',
          'sourceSha':SOURCE,'captureRunId':RUN,'transport':{'tlsVerified':True,'caBundleSha256':'b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77'},
          'claims':{'originalClaimSha256':ORIGINAL,'recoveryClaimSha256':RECOVERY,'continuationClaimSha256':CONTINUATION},'locatorPresent':bool,'bindingPresent':bool,
          'state':{'candidate':{'id':'557b5b98-f591-50ce-83ea-2ca44d44567a','status':'WORD','governed_status':'WORD','row_version':'VERSION','clio_id':N('UUID'),'item_id':N('UUID'),'decided_by':N('UUID'),'approved_by':N('UUID')},
            'clio':[{'id':'UUID','row_version':'VERSION','source_version':'DATE','legacy_embedding_present':bool,'content_sha256':'HASH'}],
            'items':[{'id':'UUID','row_version':'VERSION','status':'WORD','governed_status':'WORD','approved_by':N('UUID'),'source_version_sha256':N('HASH'),'source_content_hash_sha256':N('HASH'),'projection_content_sha256':'HASH'}],
            'outbox':[{'id':'UUID','item_id':N('UUID'),'clio_id':'UUID','operation':('index_memory_item',),'status':'WORD','attempts':int,'expected_content_hash':N('HASH'),'lease_present':bool,'expected_source_version':N('DATE'),'completed_at':N('DATE'),'superseded_at':N('DATE'),'idempotency_key_sha256':'HASH','idempotency_matches':bool,'error_present':bool,'error_sha256':N('HASH')}],
            'embeddings':[{'id':'UUID','source_id':'UUID','content_hash':'HASH','embedding_present':bool,'model_sha256':'HASH','model_is_titan_v2':bool,'matches_item_content':bool}],
            'audits':[{'id':'UUID','from_status':N('WORD'),'to_status':'WORD','actor_id':N('UUID'),'item_id':N('UUID')}]},
          'role':{'name_sha256':'HASH','superuser':bool,'bypass_rls':bool},'tables':[{'name':table,'rls':bool,'forced':bool,'current_user_owns':bool}],
          'policies':[{'table_name':table,'name_sha256':'HASH','predicate_sha256':'HASH','mentions_tenant':bool,'mentions_bypass':bool}],
          'visibility':{'tenantPendingJobIds':['UUID'],'systemTenantSetting':('MISSING','EMPTY','PRESET'),'systemRead':{'outbox':query,'clio':query,'items':query,'embeddings':query}}}
        for message in messages:
            for line in message.splitlines():
                if not line.startswith(PREFIX):continue
                m.need(len(line.encode())<=24000,'RECEIPT_SIZE');entry=parsed(line[len(PREFIX):].encode());m.sanitize(entry)
                if entry.get('status')=='READBACK_COMPLETE':
                    validate(entry,shape)
                    state=entry['state'];candidate=state['candidate']
                    m.need(len(state['clio'])<=1 and len(state['items'])<=1,'EXACT_POINTER_ROWS')
                    for row in state['clio']:m.need(row['id']==candidate['clio_id'],'CLIO_POINTER')
                    for row in state['items']:m.need(row['id']==candidate['item_id'],'ITEM_POINTER')
                    for row in state['outbox']:m.need(row['clio_id']==candidate['clio_id'],'JOB_POINTER')
                    for row in state['embeddings']:m.need(row['source_id']==candidate['item_id'],'VECTOR_POINTER')
                    for rows in [state['clio'],state['items'],state['outbox'],state['embeddings'],state['audits']]:m.need(len({r['id'] for r in rows})==len(rows),'DUPLICATE_ROWS')
                    for value in entry['visibility']['systemRead'].values():
                        m.need(value['status']=='READ' and value['sqlState'] is None or value['status']=='QUERY_FAILED' and value['ids']==[],'QUERY_OUTCOME')
                else:
                    validate(entry,{'kind':'meri-case01-projection-readback','schemaVersion':1,'status':'READBACK_FAILED','readOnly':True,'mutations':0,'liveAcceptance':'NOT_RUN',
                        'stage':('INPUT','CONNECT','OWNED_STATE','CURRENT_APPROVAL','ROLE_POLICY','SYSTEM_VISIBILITY'),
                        'code':('42883','42501','22P02','42703','42P01','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ETIMEDOUT','ECONNREFUSED','ERR_ASSERTION','READBACK_REFUSED')})
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
            m.need(args.confirm=='RUN_ONE_READONLY_CURRENT_APPROVAL_PROBE','CONFIRMATION_REQUIRED');args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
        a=m.adapter();helper,_=a.load_helpers(args.repo);aws=a.Aws('default')
        result=m.prepare(a,helper,aws,args) if args.action=='prepare' else m.run(a,helper,aws,args)
        print(json.dumps(result));return 0
    except Exception:
        print(json.dumps({'status':'BLOCKED','code':'FIXED_PROJECTION_DIAGNOSTIC_REFUSED'}));return 1
if __name__=='__main__':raise SystemExit(main())

