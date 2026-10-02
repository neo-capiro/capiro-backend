"""One fixed bill COUNT activity readback; no cancellation or database mutation."""
import argparse, hashlib, importlib.util, json, pathlib, re

ROOT=pathlib.Path(__file__).resolve().parent
BASE=ROOT.parent/'oct02-case01-release'/'case01-oneoff.py'
BASE_SHA='4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a'
SCRIPT=ROOT/'incident-bill-activity-readonly.mjs'
SCRIPT_SHA='d918d58e54a0fb7f0677fdbb98a4ada9b53820239750b26b5580796b007214ae'
INPUT=ROOT/'incident-bill-activity-input.json'
INPUT_SHA='8b6870b63cf4326356e4063861be15ccd7bd4cd33eb40fc16396792535842407'
SOURCE='42780caa75fcabe4f83e619ad81c0f36fdda8fad'
MODE='bill-activity-read'
FAMILY='capiro-dev-meri-bill-activity-read'
CONTAINER='meri-bill-activity-read'
VARIABLE='MERI_BILL_ACTIVITY_INPUT'
PREFIX='MERI_BILL_ACTIVITY_RECEIPT '

def load_operator():
    if hashlib.sha256(BASE.read_bytes()).hexdigest()!=BASE_SHA: raise RuntimeError('REVIEWED_BASE_CHANGED')
    spec=importlib.util.spec_from_file_location('fixed_enum_base',BASE)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    old_source,old_request,old_qualify=m.source_check,m.task_request,m.qualify
    m.__file__=__file__;m.ROOT=ROOT;m.FAMILY,m.CONTAINER=FAMILY,CONTAINER
    m.MODES={MODE:('node','read-only',VARIABLE)}

    def parsed(data):
        def pairs(items):
            result={}
            for key,value in items:
                m.need(key not in result,'DUPLICATE_JSON_KEY');result[key]=value
            return result
        return json.loads(data.decode('utf-8-sig'),object_pairs_hook=pairs)

    def fixed_files():
        values={}
        for name,path,expected in [('base',BASE,BASE_SHA),('script',SCRIPT,SCRIPT_SHA),('input',INPUT,INPUT_SHA)]:
            data=path.read_bytes();m.need(m.sha(data)==expected,'FIXED_'+name.upper()+'_CHANGED');values[name]=data
        inp=parsed(values['input']);m.need(inp=={'kind':'meri-bill-activity-read','sourceSha':SOURCE},'FIXED_INPUT_SCOPE')
        return inp,values['script'].decode('utf-8-sig')

    def source_check(a,repo,source_sha):
        fixed_files();m.need(source_sha==SOURCE,'FIXED_IMAGE_SOURCE_REQUIRED')
        head=a.git(repo,'rev-parse','HEAD').decode().strip()
        m.need(head=='d77cbe69da8329784c60135c1af7112d34c39900' and head==a.git(repo,'rev-parse','origin/main').decode().strip(),'EXACT_REVIEWED_MAIN_REQUIRED')
        m.need(not a.git(repo,'status','--porcelain=v1','--untracked-files=all').strip(),'DIRTY_OPERATOR_SOURCE')
        m.need(a.git(repo,'remote','get-url','origin').decode().strip().removesuffix('.git')=='https://github.com/neo-capiro/capirov2','NONCANONICAL_REPOSITORY')
        m.need(a.git(repo,'merge-base',SOURCE,head).decode().strip()==SOURCE,'SERVED_SOURCE_NOT_ANCESTOR')
        # This fixed SELECT-only task executes pinned old image bytes and external
        # script, not new application code. All host-loaded operational helpers
        # and the sole in-image DB composer remain byte-identical to served427.
        m.need(not a.git(repo,'diff','--name-only',SOURCE,head,'--','scripts','apps/api/scripts/lib/pe-compose-database-url.js').strip(),'DIAGNOSTIC_DEPENDENCY_DRIFT')
        return head

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
            m.need(isinstance(value,list) and len(value)<=20,'BOUNDED_ROWS')
            for row in value:validate(row,shape[0])
        elif isinstance(shape,tuple):
            if shape[0]=='nullable':
                if value is not None:validate(value,shape[1])
            else:m.need(value in shape,'RECEIPT_ENUM')
        elif shape is bool:m.need(type(value) is bool,'BOOLEAN_REQUIRED')
        elif shape is int:m.need(type(value) is int and 0<=value<=1000000,'INTEGER_REQUIRED')
        elif shape=='UUID':m.need(isinstance(value,str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',value),'UUID_REQUIRED')
        elif shape=='HASH':m.need(isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value),'HASH_REQUIRED')
        elif shape=='EVENT':m.need(isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_:]{1,80}',value),'EVENT_REQUIRED')
        elif shape=='WORD':m.need(isinstance(value,str) and re.fullmatch(r'[a-z_]{1,40}',value),'STATUS_REQUIRED')
        elif shape=='VERSION':m.need(isinstance(value,str) and re.fullmatch(r'[0-9]{1,20}',value),'ROW_VERSION_REQUIRED')
        elif shape=='DATE':m.need(isinstance(value,str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z',value),'DATE_REQUIRED')
        else:m.need(type(value) is type(shape) and value==shape,'FIXED_RECEIPT_VALUE')

    def owner_receipts(messages,mode,require_success=True):
        m.need(mode==MODE,'FIXED_DIAGNOSTIC_ONLY');entries=[];N=lambda v:('nullable',v)
        state=('active','idle','idle in transaction','idle in transaction (aborted)','fastpath function call','disabled',None)
        for message in messages:
            for line in message.splitlines():
                if not line.startswith(PREFIX):continue
                m.need(len(line.encode())<=24000,'RECEIPT_SIZE');entry=parsed(line[len(PREFIX):].encode());m.sanitize(entry)
                if entry.get('status')=='READBACK_COMPLETE':
                    validate(entry,{'kind':'meri-bill-activity-readback','schemaVersion':1,'status':'READBACK_COMPLETE','readOnly':True,'mutations':0,'sourceSha':SOURCE,'observedAt':'DATE','roleSha256':'HASH','databaseSha256':'HASH','tlsVerified':True,'caBundleSha256':'b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77','aggregate':[{'state':state,'wait_event_type':N('EVENT'),'count':int,'max_active_age_seconds':int}], 'matchedQueries':[{'pid':int,'state':'active','wait_event_type':N('EVENT'),'wait_event':N('EVENT'),'age_seconds':int,'backendStart':'DATE','queryStart':'DATE','querySha256':'HASH','exactCountShape':True}],'queryTextPersisted':False})
                    rows=entry['matchedQueries'];m.need(len({r['pid'] for r in rows})==len(rows),'DUPLICATE_PID')
                    for row in rows:m.need(row['pid']>0 and row['age_seconds']>=30,'BOUNDED_OLD_QUERY_ONLY')
                else:
                    validate(entry,{'kind':'meri-bill-activity-readback','schemaVersion':1,'status':'READBACK_FAILED','readOnly':True,'mutations':0,'stage':('INPUT','CONNECT','ACTIVITY'),'code':('42501','57014','ETIMEDOUT','ECONNREFUSED','ERR_ASSERTION','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','READBACK_REFUSED')})
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
            m.need(args.confirm=='RUN_ONE_READONLY_BILL_ACTIVITY_PROBE','CONFIRMATION_REQUIRED');args.confirm='RUN_ONE_REVIEWED_CASE01_TASK'
        a=m.adapter();helper,_=a.load_helpers(args.repo);aws=a.Aws('default')
        result=m.prepare(a,helper,aws,args) if args.action=='prepare' else m.run(a,helper,aws,args)
        print(json.dumps(result));return 0
    except Exception:
        print(json.dumps({'status':'BLOCKED','code':'FIXED_BILL_ACTIVITY_REFUSED'}));return 1
if __name__=='__main__':raise SystemExit(main())


