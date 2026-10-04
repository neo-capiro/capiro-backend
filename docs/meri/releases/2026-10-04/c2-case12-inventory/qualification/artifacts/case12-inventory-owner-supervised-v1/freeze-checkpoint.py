from pathlib import Path
import json, hashlib, difflib, shutil, subprocess
from datetime import datetime, timezone

out=Path(__file__).parent
root=out.parent
repo=Path('C:/dev/main/meri-c1-20261002')
hermes=root/'case12-inventory-owner-hermes-v1'
inputs=root/'case12-inventory-owner-inputs-v1'
def pin(p):
 p=Path(p);b=p.read_bytes();return {'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
paths=['evals/meri/live-v1/fixture-provisioning/case12-memory-inventory-owner.mjs','evals/meri/live-v1/tests/case12-memory-inventory-owner.test.mjs']
proposed=out/'proposed';proposed.mkdir(exist_ok=False)
patch=[];delta=[]
for rel in paths:
 p=out/'scratch'/rel;dst=proposed/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dst)
 lines=p.read_text().splitlines(keepends=True)
 patch += [f'diff --git a/{rel} b/{rel}\n','new file mode 100644\n']
 patch += list(difflib.unified_diff([],lines,fromfile='/dev/null',tofile='b/'+rel))
 delta += list(difflib.unified_diff((hermes/'candidate'/rel).read_text().splitlines(keepends=True),lines,fromfile='hermes/'+rel,tofile='supervised/'+rel))
(out/'proposed.patch').write_text(''.join(patch),encoding='utf-8')
(out/'supervision-delta.patch').write_text(''.join(delta),encoding='utf-8')
check=subprocess.run(['git','apply','--check',str(out/'proposed.patch')],cwd=repo,capture_output=True,text=True)
(out/'patch-check.log').write_text(check.stdout+check.stderr,encoding='utf-8')
assert check.returncode==0,check.stderr
manifest=json.loads((inputs/'manifest.json').read_text())
checks=[]
for item in manifest['sourceFiles']:
 rel=item['path'];copies=[inputs/'source'/rel,hermes/'evidence/source'/rel,out/'scratch'/rel,repo/rel]
 for p in copies:
  actual=pin(p);checks.append({'path':str(p),'sha256':actual['sha256'],'passed':actual['sha256']==item['sha256']})
assert all(c['passed'] for c in checks)
extra=repo/'apps/api/src/memory/memory-canonical-activation.helpers.ts'
shutil.copyfile(extra,out/'memory-canonical-activation.helpers.ts.source.txt')
execution=json.loads((hermes/'execution.json').read_text())
hermesFiles=[]
for item in execution['files']:
 p=hermes/item['path'];actual=pin(p);assert actual['sha256']==item['sha256'];hermesFiles.append(actual)
limitations=[
 'Source-only internal owner proposal. No exact original MA510 manifest/seed inventory was located; current live inventory remains unknown. No discovery, connection, seed, reset, approval or capture entrypoint is added.',
 'Tests use real manifest/definitions/hash functions and mocked transaction/canonical-helper/auth seams. No PostgreSQL execution, RLS integration or served inspection was run. SQL timestamp ordering is source-reviewed and mocked; it is not actual live age proof.',
 'A positive inventory result means current canonical guard/read-permission checks and SQL age count would have passed for that transaction. It explicitly leaves retrieval eligibility unqualified: read permission is not the full retrieval eligibility predicate or semantic-clock proof.',
 'Case12 still requires source-owned real eligibility/age proof and its own capture/clock/source/provider/native aggregate admission, actual original prompt/full-passage evidence, and human rubric. fixtureReady and captureAuthority remain false; liveAcceptance remains NOT_RUN.',
 'The original canonical guard is supplied by trusted application source composition, not JSON. This module does not create a WeakMap live capability or authenticate runtime/server identity; a future native adapter must bind the real services and transaction.',
 'Actual Hermes file-only implementation timed out after720s with no final response/usage receipt. Its two raw files and notes remain unchanged. Codex repaired and expanded the proposal and ran the tests. This is not an independent Hermes PASS review.',
 'The initial precompletion draft run failed11of22 tests; its log is preserved. That intermediate test-file byte snapshot was not separately frozen before correction, so it is diagnostic only. Final proposed bytes and complete final test logs are pinned below.',
]
changes=[
 'Accept exact native seed receipt liveAcceptance=NOT_RUN and qualify the source-supported500–600 distractor count; retain complete definition/id/hash binding and prohibit arbitrary extra flags.',
 'Require the native guard actual four-field candidate/item version, candidate ID and marker proof; verify canonical authorization subject identity/status and scoped item reads.',
 'Bind ordinary Pat manifest identity and tenant, snapshot caller context, capture auth methods, retain membership locks, scope target age subqueries and reject impossible counts.',
 'Bound PostgreSQL xid versions, require canonical candidate source-version representation and array sections, retain source content/section hashes without confusing representations.',
 'Repair failed mock candidate lookup/actor identity/frozen fixture mutation/payload comparison and change stale-version test to current native read rejection. Add native receipt/500/600/proof/foreign subject/context mutation/count tests.',
]
checkpoint={'kind':'case12-inventory-owner-supervised-local-proposal','at':datetime.now(timezone.utc).isoformat(),
 'status':'LOCAL_MOCKED_QUALIFICATION_PASS_AWAITING_INDEPENDENT_SOURCE_REVIEW',
 'hermes':{'execution':pin(hermes/'execution.json'),'exitCode':execution['exitCode'],'failure':execution['failure'],
 'modelOverride':execution['modelOverride'],'providerOverride':execution['providerOverride'],'usageReceiptAvailable':(hermes/'usage.json').exists(),'rawFiles':hermesFiles},
 'proposedFiles':[pin(proposed/p) for p in paths],'patch':pin(out/'proposed.patch'),'supervisionDelta':pin(out/'supervision-delta.patch'),
 'testResults':[{'log':pin(out/'hermes-draft-tests-v1.log'),'pass':11,'fail':11,'status':'DIAGNOSTIC_PRECOMPLETION_DRAFT'},
 {'log':pin(out/'supervised-tests-v1.log'),'pass':34,'fail':0},
 {'log':pin(out/'final-tests.log'),'pass':36,'fail':0,'skip':0,'composition':'34new owner boundary tests plus2unchanged approved-memory definition tests'}],
 'patchCheck':{'exitCode':check.returncode,'log':pin(out/'patch-check.log')},'sourceCopyChecks':checks,
 'additionalSourcePin':pin(extra),'corrections':changes,'remainingBoundaries':limitations,
 'scope':{'repositoryEdits':0,'cloudCalls':0,'applicationProviderCalls':0,'databaseCalls':0,'journalChanges':0,
 'fixtureMutation':False,'currentLiveInventory':'UNKNOWN_NOT_READ','captureAuthority':False,'fixtureReady':False,'originalCase12':'NOT_RUN','humanRubric':'NOT_RUN'}}
(out/'checkpoint.json').write_text(json.dumps(checkpoint,indent=2)+'\n')
readme=['# Case12 inventory owner: proposed local slice',
 'Actual configured Hermes wrote the initial two-file draft in its output directory. The session timed out (exit124); raw source, notes and failed diagnostic tests are retained. Codex supervised the corrections below. This proposal has not been integrated or independently source-reviewed.',
 '**Final qualification:36/36 Node tests passed (34owner-boundary tests plus2unchanged approved-memory definition tests). git apply --check passed.**',
 '## Proposed files',*['- '+p for p in paths],
 'Apply only proposed.patch after independent review. The source closure and mock harness are scratch copies; no repository file was changed.',
 '## Corrections',*['- '+x for x in changes],
 '## Remaining boundaries',*['- '+x for x in limitations],
 '## Existing source references',
 '- approved-memory-runtime.mjs:249–253 inspection;354–363 actual native seed receipt. The new owner reuses its definition/identity contract and the existing direct in-transaction canonical guard pattern in capture-binding-runtime.mjs.',
 '- synthetic-approved-memory.helpers.ts:264–268 exact native proof return; memory-canonical-activation.helpers.ts:112 canonical candidate sourceVersion. Their source bytes are pinned.',
 '- Checkpoint contains all proposed/raw file hashes, test-log hashes, source-copy comparisons and scopes. No caller-supplied JSON result is a live capability.',
 ]
(out/'README.md').write_text('\n\n'.join(readme)+'\n')
print(json.dumps({'checkpoint':pin(out/'checkpoint.json'),'proposal':checkpoint['proposedFiles'],'checks':len(checks),'testsPassed':36,'patch':pin(out/'proposed.patch')}))
