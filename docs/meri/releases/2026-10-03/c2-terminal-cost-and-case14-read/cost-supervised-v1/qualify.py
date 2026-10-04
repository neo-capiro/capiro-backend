import hashlib,json,pathlib,subprocess,sys,datetime,re
ROOT=pathlib.Path(__file__).resolve().parent
REPO=pathlib.Path('C:/dev/main/meri-c1-20261002')
NODE='C:/Program Files/nodejs/node.exe'
JOURNAL=pathlib.Path('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')
def h(b):return hashlib.sha256(b).hexdigest()
before=JOURNAL.read_bytes()
assert h(before)=='d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b'
case01=REPO/'evals/meri/live-v1/tests/case01-failed-receipt-cost.unit.py'
copy=ROOT/'case01-legacy-native.unit.py'
copy.write_text(case01.read_text().replace('BASE=pathlib.Path(__file__).resolve().parent',"BASE=pathlib.Path('C:/dev/main/meri-c1-20261002/evals/meri/live-v1/tests')").replace('case01-terminal-cost-local-v1','cost-supervised-v1/case01-legacy-native'),newline='\n')
adapted=[]
for name in ['capture-spend-aggregate','capture-spend-terminal','capture-spend-reconciliation','capture-spend-v2']:
 source=REPO/('evals/meri/live-v1/tests/'+name+'.test.mjs')
 content=source.read_text().replace('C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe',sys.executable.replace('\\','/'))
 content=re.sub(r"const parent = '[^']+';", "const parent = '"+str(ROOT).replace('\\','/')+'/'+name+"';",content)
 content=re.sub(r"(from |new URL\()'(\.{1,2}/[^']+)'",lambda m:m[1]+"'"+(source.parent/m[2]).resolve().as_uri()+"'",content)
 target=ROOT/(name+'.adapted.test.mjs');target.write_text(content,newline='\n');adapted.append(str(target))
commands=[
 ('node-cost-regressions',[NODE,'--test','evals/meri/live-v1/tests/case20-terminal-cost.test.mjs','evals/meri/live-v1/tests/case01-failed-receipt-cost.test.mjs']),
 ('case20-native',[sys.executable,'-I','evals/meri/live-v1/tests/case20-terminal-cost.unit.py']),
 ('case01-native',[sys.executable,'-I',str(copy)]),
 ('aggregate-regressions-adapted',[NODE,'--test',*adapted]),
 ('operator-syntax',[NODE,'--check',str(ROOT/'run-case20-terminal-cost-once.mjs')]),
]
tests=[]
for name,cmd in commands:
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 p=subprocess.run(cmd,cwd=REPO,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 log=ROOT/(name+'.log');log.write_bytes(p.stdout)
 tests.append(dict(name=name,command=cmd,exitCode=p.returncode,startedAt=start,log=str(log),logSha256=h(p.stdout)))
 print(name,p.returncode,flush=True)
assert JOURNAL.read_bytes()==before
sources=[]
files=[REPO/'evals/meri/live-v1'/f for f in ['case20-terminal-cost-authority.mjs','case20-terminal-cost-pins.mjs','capture-spend-aggregate.mjs','lib/windows-capture-spend.py','tests/case20-terminal-cost.test.mjs','tests/case20-terminal-cost.unit.py','tests/fixtures/case20-terminal-cost.unit.json','tests/fixtures/case20-terminal-cost-proof.unit.json','tests/fixtures/case20-terminal-cost-journal23.unit.jsonl']]
files += [ROOT/'run-case20-terminal-cost-once.mjs',ROOT/'qualify.py']
for path in files:
 b=path.read_bytes();sources.append(dict(path=str(path),bytes=len(b),sha256=h(b)))
checkpoint=dict(kind='case20-terminal-cost-offline-qualification',status='PASS' if all(t['exitCode']==0 for t in tests) else 'FAIL',
 sources=sources,tests=tests,preparedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
 canonicalProofSha256='305283f0048a7f7ae82dc322f8353a2499cc444cc2e60537736375d0e5eed3a0',
 journalBeforeSha256=h(before),journalAfterSha256=h(JOURNAL.read_bytes()),journalUnchanged=True,
 currentEventCount=23,proposedEventCount=24,chargedCostMicros=1497175,knownFreshCostAfterMicros=13631058,
 remainingFreshBudgetAfterMicros=16368942,captureAuthority=False,captureStatus='CAPTURE_UNCERTAIN',answerGrade='NOT_EVALUATED',
 liveAppend='NOT_RUN',cloudCalls=0,modelSubmissions=0,independentReview='PENDING',
 limitations=['Evidence pins intentionally address retained local outputs; pin-copy integration test needs those files.',
 'Cost-only terminal closure is not benchmark acceptance and does not qualify a future capture.',
 'Existing server-authenticated BLOCKED signed envelope is joined offline; no secret is loaded to re-sign or re-verify HMAC.'])
(ROOT/'checkpoint.json').write_text(json.dumps(checkpoint,indent=2)+'\n',newline='\n')
print(json.dumps({'status':checkpoint['status'],'checkpointSha256':h((ROOT/'checkpoint.json').read_bytes()),'journalUnchanged':True}))
assert checkpoint['status']=='PASS'
