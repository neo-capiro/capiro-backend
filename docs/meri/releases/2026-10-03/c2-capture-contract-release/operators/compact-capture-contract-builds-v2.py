from pathlib import Path
import yaml,json,gzip,base64,hashlib,copy
root=Path('C:/dev/main/outputs/meri-c2-20261003')
pins={}
for service in ['api','meriv2-orchestrator']:
    before=(root/f'{service}-capture-contract-build-v1/buildspec.yml').read_bytes()
    data=yaml.safe_load(before)
    after=copy.deepcopy(data)
    proof=[]
    for phase,value in data['phases'].items():
        commands=[]
        for index,command in enumerate(value['commands']):
            raw=command.encode('utf-8')
            encoded=base64.b64encode(gzip.compress(raw,mtime=0)).decode('ascii')
            assert gzip.decompress(base64.b64decode(encoded))==raw
            commands.append("set -euo pipefail\nprintf '%s' '"+encoded+"' | base64 -d | gzip -dc | bash")
            proof.append({'phase':phase,'index':index,'decodedBytes':len(raw),'decodedSha256':hashlib.sha256(raw).hexdigest(),'codec':'gzip-base64','exactDecodedOriginalCommand':True})
        after['phases'][phase]['commands']=commands
    encoded=json.dumps(after,separators=(',',':')).encode()
    assert len(encoded)<25600
    assert yaml.safe_load(encoded)==after
    out=root/f'{service}-capture-contract-build-v2';out.mkdir()
    (out/'buildspec.yml').write_bytes(encoded)
    pins[service]=hashlib.sha256(encoded).hexdigest()
    (out/'lossless-compaction.json').write_text(json.dumps({'service':service,'originalBuildspecSha256':hashlib.sha256(before).hexdigest(),'compactedBuildspecSha256':pins[service],'originalBytes':len(before),'compactedBytes':len(encoded),'phaseCommandProof':proof,'limits':'Only the inline carrier changes. Each phase executes its exact original reviewed bash program; no assertion/test/guard/command removed. No cloud action by this generator.'},indent=2)+'\n')
s=(root/'start-capture-contract-build-v2.mjs').read_text()
s=s.replace('${service}-capture-contract-build-v1','${service}-capture-contract-build-v2')
for old,new in zip(['50ad3b3e94750abb350820e66aae2cc4b9bde0564eb45d73eb471e504823dc2a','c23d52da40dbab3aa4f2fda523cd748718c41f8791059edd2fe1fd44c00ad389'],pins.values()):s=s.replace(old,new)
before="const request={projectName:project.name"
assert before in s
s=s.replace(before,"need(Buffer.byteLength(buildspec,'utf8')<25600,'INLINE_BUILDSPEC_TOO_LONG');\nconst rejected=JSON.parse(readFileSync(`C:/dev/main/outputs/meri-c2-20261003/${service}-capture-contract-build-v1/start-reconciliation.json`,'utf8'));\nneed(rejected.status==='DEFINITE_SERVICE_REJECTION_NO_BUILD_STARTED'&&rejected.service===service&&rejected.sourceSha===sha,'PRIOR_REJECTED_LAUNCH_NOT_RECONCILED');\n"+before)
(root/'start-capture-contract-build-v3.mjs').write_text(s,encoding='utf-8',newline='\n')
s=(root/'collect-capture-contract-build-v1.mjs').read_text().replace('${service}-capture-contract-build-v1','${service}-capture-contract-build-v2')
for old,new in zip(['50ad3b3e94750abb350820e66aae2cc4b9bde0564eb45d73eb471e504823dc2a','c23d52da40dbab3aa4f2fda523cd748718c41f8791059edd2fe1fd44c00ad389'],pins.values()):s=s.replace(old,new)
(root/'collect-capture-contract-build-v2.mjs').write_text(s,encoding='utf-8',newline='\n')
print(json.dumps({'buildspecs':pins,'startSha256':hashlib.sha256((root/'start-capture-contract-build-v3.mjs').read_bytes()).hexdigest(),'collectorSha256':hashlib.sha256((root/'collect-capture-contract-build-v2.mjs').read_bytes()).hexdigest()}))
