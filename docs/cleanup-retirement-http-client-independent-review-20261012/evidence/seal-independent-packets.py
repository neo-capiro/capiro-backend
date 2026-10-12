from pathlib import Path
import subprocess,json,hashlib
root=Path.cwd();memory=root/'docs/cleanup-memory-funding-fixtures-independent-review-20261012';http=root/'docs/cleanup-retirement-http-client-independent-review-20261012';base='d587441261fd356ee5144a8fc29cb2f771d062b8';head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()
assert head=='68c6c13e2aee90aea18fca12efd4f68f1f286c52'
a=json.loads((memory/'evidence/source-inverse-audit.json').read_text());b=json.loads((http/'evidence/source-oracle-audit.json').read_text());permitted=set(a['exact10SourcePaths']+b['sourceChanges']);delta=set(subprocess.check_output(['git','diff','--name-only',base,head,'--',':!docs'],text=True).splitlines());assert delta==permitted
assert subprocess.check_output(['git','diff','--name-only'],text=True).strip()==''
for packet in [memory,http]:
    for p in (packet/'evidence').glob('*.json'):
        if p.name.endswith('.jest.json') or p.name.endswith('.reader.json'):continue
        try:r=json.loads(p.read_text())
        except Exception:continue
        if isinstance(r,dict) and 'rawLog' in r:
            q=Path(r['rawLog']['path']);raw=q.read_bytes();assert hashlib.sha256(raw).hexdigest()==r['rawLog']['sha256'] and len(raw)==r['rawLog']['bytes']
assert 'ℹ pass 48' in (http/'evidence/01-published-controls.tap').read_text();assert 'ℹ fail 0' in (http/'evidence/01-published-controls.tap').read_text()
assert 'ℹ pass 18' in (http/'evidence/05-independent-fake-adversaries.tap').read_text();assert 'ℹ fail 0' in (http/'evidence/05-independent-fake-adversaries.tap').read_text();assert (http/'evidence/06-client-strict-types.log').read_bytes()==b''
http_result={'acceptedSource':'e02e4fbc384b997eaf0e6f8ca6659e5599bd7c10','acceptedTree':'4608895b796a9256257e967a60408d5e482abee3','reviewerSourceComposition':{'head':head,'tree':tree,'sourcePaths':13,'reviewerOwnSourceEdits':0},'commands':[{'command':'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --test scripts/ci/meri-durable-http-client-contract.spec.mjs','exitCode':0,'fakeTests':48,'skips':0},{'command':'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --test docs/cleanup-retirement-http-client-independent-review-20261012/evidence/independent-fake-adversaries.cjs','exitCode':0,'fakeTests':18,'skips':0},{'command':'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node /workspace/capirov2/node_modules/typescript/bin/tsc --project docs/cleanup-retirement-import-free-http-client-20261012/tsconfig.client.json','exitCode':0,'scope':'strict standalone ES2022/DOM, types empty, noEmit'}],'independentOracleDeclarations':27,'reachableRuntimeValues':18,'nativeIntegration':{'cases':1,'expectCalls':13,'run':False,'entireImportOnlyInverseExact':True},'correction':'21+21 are the original and candidate FAKE-fetch corpus, not native API cases. Frozen original author wording is historical; this independent count/source binding corrects the scope.','reviewHelperReds':['02 CJS wrapper exports-name collision','03 incorrect inherited21-native-case expectation; actual1it/13expect independently measured'],'open':['native API integration/bootstrap','real transport/provider/database/RLS/migrations','broader prototype/closeout/scope/native/full floors'],'realFetchCalls':0,'appOrFrontendSourceChange':False,'acceptance':'bounded3path import-free testclient/source/body/behavior equivalence only'}
(http/'RESULT.json').write_text(json.dumps(http_result,indent=2)+'\n')
(memory/'HANDOFF.md').write_text('''Accepted the exact ten-path static-input slice at `44eda40f7951e73722566862649939e51a8f151a` / tree `d13ee8799aa89c5a55d2d96efdbd9458c6e4439f`. Seven fixture blobs match the actual destination Web source at `d587441261fd356ee5144a8fc29cb2f771d062b8` and the independently captured pre-candidate `fe50dc1c2de1660a036e338cf81acdcf0f2fb26a` source. All three spec inverses are byte-exact after restoring only four reader operands; every case, assertion and opaque backend source input remains intact. No production/frontend/module/Shared/schema/qualification source changes occur elsewhere.

The actual three owner specs have 60 cases: 59 pass and the same one inherited Memory editor-literal assertion fails, with zero pending. Original and candidate full-name/status maps are identical. The current `MemoryFileEditor` delegates wording to a separate helper, so the spec's direct `Submitted for approval` expectation is absent; this slice does not repair or waive it. Initial wrong cached Jest-environment path failure is retained as reviewer-host evidence.

A meaningful source dependency probe synthetically refuses reads of exactly the seven original Web inputs in the owned test process. The original suites then fail all three collections before cases run. The candidate performs zero blocked Web reads and eight local fixture reads across seven unique fixtures, while preserving the same 59/1 case outcomes. No Web file is deleted or modified, and source `.txt` contents are read rather than evaluated.

The audited runtime import inventory has 31 source modules with only Node fs/path and Jest as external runtime imports. Runs use real cached Jest29/ts-jest, current Shared source, no database setup, no application bootstrap or native/provider execution. Transpiler diagnostics are separate from full type/native acceptance.

This accepts the bounded backend static fixture adoption, retaining the inherited RED. It does not qualify current browser behavior, database/RLS/migration or wider prototype/closeout/native/full gates. Author evidence `6627e7c63a07f7afc1f31e75ad21f0286172e897` remains a separate immutable receipt over unchanged source44. Root owns adoption/publication.

See `BASELINE-IDENTITIES.json`, `evidence/source-inverse-audit.json`, the original and candidate raw Jest logs/JSON, `evidence/05-candidate-web-unavailable.reader.json`, and `SHA256-INDEX.json`. Only published CODE blobs were compared to latest PR2423; the denied newer report was not accessed or copied.
''')
(http/'HANDOFF.md').write_text('''Accepted the exact three source paths at `e02e4fbc384b997eaf0e6f8ca6659e5599bd7c10` / tree `4608895b796a9256257e967a60408d5e482abee3`. The native integration spec has exactly one `it` case and 13 `expect` calls. Its whole file is byte-exact after normalizing only the Web-to-local helper import. The original source and its preserved full native case were not executed.

The immutable oracle is independently bound to the actual destination Web module at `d587441261fd356ee5144a8fc29cb2f771d062b8`: 27 declarations are exact, and all 18 reachable runtime values for the three imported methods are present without unrelated runtime utilities. Seventeen candidate runtime declaration texts match after removing leading exports; the Error constructor's equivalent TypeScript parameter/field declarations are covered by descriptor behavior checks. The client imports nothing and exports only the three methods already used by this integration spec. All other runtime, Shared, schema, frontend, prior qualification and source-fix paths remain untouched.

Published controls replay 48/48 with zero skips: 21 original fake-fetch cases, 21 candidate fake-fetch cases and six mutations/boundary checks. Independent controls add 18/18 original/candidate cases for Error field descriptors, request/response getters, asynchronous rejection and pre-transport serialization failures, sparse arrays, unsafe integer rejection, retained enum coercion, and raw receipt aliases without an echo-ID check. All execution uses VM-injected fake fetch; no real HTTP, provider, app bootstrap, database or native integration ran. Strict standalone TypeScript5.9.3 ES2022/DOM compilation exits0.

The old wording of “21 native integration cases” was inaccurate: 21 describes each fake-fetch corpus. This packet binds the correct one-native-case/13-expect count, preserves both failed reviewer helper attempts, and does not silently rewrite the frozen author receipt. Root accepted the count correction and owns a separate active handoff erratum. Existing raw numeric serialization, response validation and absence of receipt echo-ID validation are preserved; this test client is not an authorization owner or a new service.

Latest published PR2423 CODE `67fa9255b8a73f489d7a57c8fe270ed6d03fa016` has the same selected 13 CODE blobs as `d09429a509d5b3cc2501f3736e619723e4b2c4c0`. No denied new detailed report was read, copied or published. Broader prototype/closeout/native/operator/full floors remain held. Acceptance is limited to these three test-source paths and their fake transport equivalence.

See `RESULT.json`, `evidence/source-oracle-audit.json`, the bound original source snapshots, published and independent raw control logs, strict compiler log, `evidence/latest-code-only-binding.json`, and `SHA256-INDEX.json`. The reviewer source composition is a true merge of the two frozen accepted sources, with no reviewer source edits; root owns publication.
''')
counts=[]
for packet in [memory,http]:
    rows=[]
    for p in sorted(packet.rglob('*')):
        if not p.is_file() or p.name=='SHA256-INDEX.json' or 'local-cache' in p.parts:continue
        raw=p.read_bytes();rows.append({'path':str(p.relative_to(root)),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
    (packet/'SHA256-INDEX.json').write_text(json.dumps({'scope':'This curated independent packet only, excluding index itself and owned caches. Source binds are separate exact immutable-pin receipts.','files':rows},indent=2)+'\n')
    for r in rows:assert hashlib.sha256((root/r['path']).read_bytes()).hexdigest()==r['sha256']
    counts.append({'packet':packet.name,'indexedFiles':len(rows)})
print(json.dumps({'packets':counts,'sourcePinsAccepted':[a['sourceHead'],b['sourceHead']],'nativeCasesActuallyRun':0,'reviewerSourceEdits':0}))
