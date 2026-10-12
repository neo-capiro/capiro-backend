import pathlib,subprocess,json,hashlib
root=pathlib.Path(__file__).resolve().parents[3];p=pathlib.Path(__file__).resolve().parent
base='d587441261fd356ee5144a8fc29cb2f771d062b8';proposal='67fa9255b8a73f489d7a57c8fe270ed6d03fa016'
runner='scripts/verify-outreach-v3-p1-architecture.mjs';contract='docs/contracts/outreach-v3-verification-inputs-v1.md';control='scripts/ci/outreach-operating-inputs.spec.mjs'
def get(ref,path):return subprocess.check_output(['git','show',f'{ref}:{path}'],cwd=root)
def sha(data):return hashlib.sha256(data).hexdigest()
original=get(base,runner);published=get(proposal,runner);assert original==(root/runner).read_bytes()==(p/'original-verifier.mjs.txt').read_bytes()
value=original.decode();addition=published.decode();start=addition.index('// Owned verification-input contract:');end=addition.index('// End owned verification-input contract.\n\n',start)+len('// End owned verification-input contract.\n\n');helper=addition[start:end]
assert value.count("import { fileURLToPath } from 'node:url';\n")==1
value=value.replace("import { fileURLToPath } from 'node:url';\n","import { fileURLToPath } from 'node:url';\nimport { createHash } from 'node:crypto';\n")
assert value.count('export function validateCapabilityCatalog(')==1
value=value.replace('export function validateCapabilityCatalog(',helper+'export function validateCapabilityCatalog(')
before="    'docs/plans/outreach-v3/revised-phase-1-shared-foundations.md',\n    'docs/plans/outreach-v3/revised-phase-2-readiness.md',\n"
after='    VERIFICATION_INPUTS_DOCUMENT,\n';assert value.count(before)==1;value=value.replace(before,after)
originalCheck='    if (!exists(requiredDoc)) problems.push(`missing required documentation ${requiredDoc}`);\n'
addedCheck='    else if (requiredDoc === VERIFICATION_INPUTS_DOCUMENT) {\n      problems.push(...validateVerificationInputsDocument(read(requiredDoc)));\n    }\n'
assert value.count(originalCheck)==1;value=value.replace(originalCheck,originalCheck+addedCheck)
assert value.count('/** @cleanup-smoke noArgsExit=0 */')==1
usage="  console.error('Usage: node scripts/verify-outreach-v3-p1-architecture.mjs (no arguments runs the existing verifier)');\n";assert value.count(usage)==1
reverse=value.replace("import { createHash } from 'node:crypto';\n",'').replace(helper,'').replace(after,before).replace(addedCheck,'');assert reverse.encode()==original
adjusted=published.decode().replace('#!/usr/bin/env node\n','#!/usr/bin/env node\n/** @cleanup-smoke noArgsExit=0 */\n').replace('function main() {\n','function main() {\n'+usage);assert value==adjusted
newContract=get(proposal,contract)
planRows=[]
for marker,path in [('outreach-v3-phase1-foundations','docs/plans/outreach-v3/revised-phase-1-shared-foundations.md'),('outreach-v3-phase2-readiness','docs/plans/outreach-v3/revised-phase-2-readiness.md')]:
    begin=f'<!-- {marker}:begin -->\n'.encode();finish=f'<!-- {marker}:end -->'.encode();assert newContract.count(begin)==1 and newContract.count(finish)==1
    body=newContract.split(begin)[1].split(finish)[0];current=get(base,path);assert body==current==(root/path).read_bytes()==get('f1e83a3f194a8ebd972e370ff6e5b5f559888b29',path)
    planRows.append({'path':path,'sha256':sha(current),'bytes':len(current),'bodyExactCurrentAndOriginal':True,'fileRemainsActive':True})
manifest={'base':base,'proposal':proposal,'originalVerifierSha256':sha(original),'candidateVerifierSha256':sha(value.encode()),'seamInverseExactOriginal':True,'publishedVerifierDeltaOnlyPreservedSmokeAndUsage':True,'designatedAdditions':['createHash import','published bounded marker/hash validator','two plan-presence operands replaced by contract operand','contract validation only for that operand'],'contractSha256':sha(newContract),'publishedControlsSha256':sha(get(proposal,control)),'plans':planRows,'newDeniedReportReadOrCopied':False}
(p/'SOURCE-MANIFEST-BEFORE-CONTROL-ADAPTATION.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/runner).write_bytes(value.encode());(root/contract).parent.mkdir(parents=True,exist_ok=True);(root/contract).write_bytes(newContract);(root/control).parent.mkdir(parents=True,exist_ok=True);(root/control).write_bytes(get(proposal,control))
print(json.dumps(manifest,indent=2))
