import pathlib,hashlib,json,subprocess,re
p=pathlib.Path(__file__).resolve().parent;root=p.parents[2]
source='1ed986c092b4b0998c82007e895463255d6f4901';base='d587441261fd356ee5144a8fc29cb2f771d062b8'
m=json.loads((p/'SOURCE-MANIFEST.json').read_text())
def sha(v):return hashlib.sha256(v).hexdigest()
def get(ref,path):return subprocess.check_output(['git','show',f'{ref}:{path}'],cwd=root)
runner='scripts/verify-outreach-v3-p1-architecture.mjs'
original=(p/'original-verifier.mjs.txt').read_bytes();assert original==get(base,runner) and sha(original)==m['originalVerifierSha256']
value=get(source,runner).decode();assert sha(value.encode())==m['candidateVerifierSha256']
start=value.index('// Owned verification-input contract:');end=value.index('// End owned verification-input contract.\n\n',start)+len('// End owned verification-input contract.\n\n')
reconstructed=value[:start]+value[end:];reconstructed=reconstructed.replace("import { createHash } from 'node:crypto';\n",'').replace('    VERIFICATION_INPUTS_DOCUMENT,\n',"    'docs/plans/outreach-v3/revised-phase-1-shared-foundations.md',\n    'docs/plans/outreach-v3/revised-phase-2-readiness.md',\n").replace('    else if (requiredDoc === VERIFICATION_INPUTS_DOCUMENT) {\n      problems.push(...validateVerificationInputsDocument(read(requiredDoc)));\n    }\n','');assert reconstructed.encode()==original
assert '/** @cleanup-smoke noArgsExit=0 */' in value and "console.error('Usage: node scripts/verify-outreach-v3-p1-architecture.mjs (no arguments runs the existing verifier)');" in value
assert get('f76a101fd8b4fe9e1437a2d433924d1b81d82325',runner)==original
expected=set(m['sourcePaths']);actual=set(subprocess.check_output(['git','diff','--name-only',base,source],cwd=root,text=True).splitlines());assert actual==expected and len(actual)==3
spec='scripts/verify-outreach-v3-p1-architecture.spec.mjs';assert get(base,spec)==get(source,spec)==(p/'original-verifier.spec.mjs.txt').read_bytes()
for row in m['plans']:assert get(base,row['path'])==get(source,row['path'])==(root/row['path']).read_bytes() and sha(get(source,row['path']))==row['sha256']
for file,count,passed,failed in [('original-six.stdout',6,6,0),('candidate-six.stdout',6,6,0),('published-unadapted-controls.stdout',112,111,1),('current-controls.stdout',112,112,0)]:
    text=(p/file).read_text()
    for key,val in [('tests',count),('pass',passed),('fail',failed),('skipped',0),('todo',0)]:assert re.search(rf'^(?:#|ℹ) {key} {val}$',text,re.M)
receipt={'source':source,'sourceTree':subprocess.check_output(['git','rev-parse',f'{source}^{{tree}}'],cwd=root,text=True).strip(),'base':base,'latestRootVerifierSourceExact':True,'latestRoot':'f76a101fd8b4fe9e1437a2d433924d1b81d82325','wholeVerifierInverseExact':True,'smokeUsageAndAllOtherOriginalBytesExact':True,'originalSixSpecByteExact':True,'oldPlansRemainActiveExact':True,'scope':sorted(actual),'sourceTestsBeforeAfter':{'before':6,'after':6,'allPass':True},'rawUnadaptedControls':{'tests':112,'pass':111,'fail':1},'currentControls':{'tests':112,'pass':112,'fail':0},'newDeniedReportReadCopiedOrPublished':False,'externalPublishedCustodyPath':'UNVERIFIED here; no artifact retrieval. Only active Git bytes and packet original copies are attested.','nativeOrWholeFloorAcceptance':False}
(p/'BINDING-CHECKS.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
