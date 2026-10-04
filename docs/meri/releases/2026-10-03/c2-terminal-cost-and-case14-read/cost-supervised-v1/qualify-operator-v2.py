import datetime,hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent
def h(b):return hashlib.sha256(b).hexdigest()
prior=(root/'checkpoint.json').read_bytes()
assert h(prior)=='a8b9325e5cd3f613cb82c59e5d3270e5147ffeb92997e82b74bf773a1960ae31'
value=json.loads(prior)
for source in value['sources']:assert h(pathlib.Path(source['path']).read_bytes())==source['sha256']
journal=pathlib.Path('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')
before=journal.read_bytes()
assert h(before)==value['journalBeforeSha256']
result=subprocess.run(['C:/Program Files/nodejs/node.exe','--test',str(root/'operator-dry.test.mjs')],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(root/'operator-dry-v2.log').write_bytes(result.stdout)
assert result.returncode==0
assert journal.read_bytes()==before
with (root/'checkpoint-v1-preserved.json').open('xb') as f:f.write(prior)
for path in [root/'operator-dry.test.mjs',pathlib.Path(__file__)]:
 b=path.read_bytes();value['sources'].append(dict(path=str(path),bytes=len(b),sha256=h(b)))
value['tests'].append(dict(name='operator-dry-v2',command=['C:/Program Files/nodejs/node.exe','--test',str(root/'operator-dry.test.mjs')],exitCode=0,log=str(root/'operator-dry-v2.log'),logSha256=h(result.stdout),count=5))
value.update(qualificationRevision=2,priorQualificationSha256=h(prior),preparedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
 operatorSourceChanged=False,operatorEscapeObservation='Actual source has bytes39,92,110,39: a correct single backslash-n escape. Display serialization added another escape layer.',
 additionalVerification='Five dry operator tests prove valid newline-terminated JSON, exact24 event count, prefix preservation, failure output, replay fencing, and intentionally doubled-escape rejection. Mock native append writes only disposable evidence copies.',
 unchangedPriorTests=177,liveAppend='NOT_RUN')
(root/'checkpoint.json').write_text(json.dumps(value,indent=2)+'\n',newline='\n')
print(json.dumps({'status':'PASS','checkpointSha256':h((root/'checkpoint.json').read_bytes()),'operatorSha256':h((root/'run-case20-terminal-cost-once.mjs').read_bytes()),'logSha256':h(result.stdout),'journalUnchanged':True}))
