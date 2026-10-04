from pathlib import Path
import base64,difflib,gzip,hashlib,json,subprocess
root=Path(__file__).resolve().parent
dst=root/'case14-backup-build-preparation-v2'
dst.mkdir(exist_ok=False)
checks=[];templates={}
scope=json.loads((root/'combined-c2-build-preparation-v1/build-scope.template.json').read_text())
for service in ['api','meriv2-orchestrator']:
    dest=dst/service;dest.mkdir()
    phases={phase:(root/'case14-backup-build-preparation-v1'/service/(phase+'-0.sh')).read_text() for phase in ['pre_build','build','post_build']}
    if service=='api':
        probe=(root/'case14-memory-source-packaged-probe-v1.cjs').read_text()
        phases['build']+="\n# Verify the actual compiled API projection/signing/request-control seam.\ndocker run --rm -i --network none --entrypoint node \"$image\" - <<'C2MEMORYSOURCE'\n"+probe+'\nC2MEMORYSOURCE\n'
        additional=['OFFLINE_PACKAGED_C2_TOOL_HTTP_SUCCESS_PASS','OFFLINE_PACKAGED_C2_CANONICAL_MEMORY_SOURCE_PASS']
    else:
        old='src/context/capture-evidence-receipt.spec.ts --runInBand'
        assert phases['build'].count(old)==1
        phases['build']=phases['build'].replace(old,'src/context/capture-evidence-receipt.spec.ts src/context/memory-capture-source.spec.ts --runInBand')
        anchor="print('CORE_CASE20_SOURCE_PROOF_NATIVE_TESTS_PASS')"
        phases['build']=phases['build'].replace(anchor,anchor+"\nfor required in ['response proof refuses same-policy callId replay','response proof refuses same-policy nonce replay','response proof refuses same-policy inputSha256 replay','request transport authenticates policy, exact input and bounded call identity']:\n    assert any(required in name for name in passed), required\nassert result['numPassedTests'] == 97\nprint('CORE_CANONICAL_MEMORY_SOURCE_NATIVE_TESTS_PASS')")
        anchor="print('ORCHESTRATOR_CASE20_SOURCE_PROOF_NATIVE_TESTS_PASS')"
        phases['build']=phases['build'].replace(anchor,anchor+"\nfor case in ['01','14']:\n  assert any('canonical memory owner joins actual Case'+case+' HTTP bytes without exposing proof to model' in name for name in passed),case\nprint('ORCHESTRATOR_CANONICAL_MEMORY_SOURCE_LOOPBACK_PASS')")
        additional=['CORE_CANONICAL_MEMORY_SOURCE_NATIVE_TESTS_PASS','ORCHESTRATOR_CANONICAL_MEMORY_SOURCE_LOOPBACK_PASS']
    spec={'version':0.2,'env':{'shell':'bash'},'phases':{}}
    for phase,source in phases.items():
        path=dest/(phase+'.sh');path.write_bytes(source.encode())
        result=subprocess.run(['C:/Program Files/Git/bin/bash.exe','-n',str(path)],capture_output=True,text=True)
        assert result.returncode==0,result.stderr
        checks.append({'path':str(path.relative_to(dst)),'bashSyntaxExit':result.returncode,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        encoded=base64.b64encode(gzip.compress(source.encode(),mtime=0)).decode()
        assert gzip.decompress(base64.b64decode(encoded)).decode()==source
        spec['phases'][phase]={'on-failure':'ABORT','commands':["set -euo pipefail\nprintf '%s' '"+encoded+"' | base64 -d | gzip -dc | bash"]}
    data=(json.dumps(spec,separators=(',',':'))+'\n').encode();assert len(data)<25600
    (dest/'buildspec.template.json').write_bytes(data)
    templates[service]={'path':str((dest/'buildspec.template.json').relative_to(dst)),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'requiredMarkers':scope['services'][service]['requiredBaselineMarkers']+scope['services'][service]['requiredAdditionalMarkers']+additional}
result=subprocess.run(['C:/Program Files/nodejs/node.exe','--check',str(root/'case14-memory-source-packaged-probe-v1.cjs')],capture_output=True,text=True)
assert result.returncode==0,result.stderr
record={'status':'LOCAL_SYNTAX_LOSSLESS_TEMPLATE_ASSEMBLY_ONLY','builds':'NOT_RUN','services':templates,'checks':checks,'probeNodeSyntaxExit':result.returncode,'backupAuthorization':'USER_REQUEST_2026_10_04_USE_BACKUP_SHIPPING_METHOD','cloudMutations':0,'schemaChange':False,'configurationChange':False}
(dst/'template-checks.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
