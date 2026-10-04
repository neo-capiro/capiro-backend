from pathlib import Path
import hashlib,json,datetime,subprocess
b=Path('C:/dev/main/outputs/meri-c2-20261003');root=b/'cost-supervised-v1'
sha=lambda v:hashlib.sha256(v).hexdigest()
cbytes=(root/'checkpoint.json').read_bytes();assert sha(cbytes)=='93538de87b791c65801cd5d43a3fe1b74428ae72fa5f53df1fa038b8f0854d29'
c=json.loads(cbytes)
for r in c['sources']:assert sha(Path(r['path']).read_bytes())==r['sha256'],r['path']
for r in c['tests']:
 assert r['exitCode']==0
 assert sha(Path(r['log']).read_bytes())==r['logSha256']
review=b/'case20-cost-hermes-review-v1/REVIEW.md';text=review.read_text(encoding='utf-8');assert 'Status: PASS' in text
usage=json.loads((review.parent/'usage.json').read_bytes());assert usage['completed'] and not usage['failed']
assert usage['model']=='openai/gpt-6-luna' and usage['provider']=='openrouter'
assert sha((root/'operator-dry-v2.log').read_bytes())=='92dbf8fa6c0e8744c124783830b332344250c94f614aea2d7d30f68319391faf'
j=Path('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');assert sha(j.read_bytes())=='d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b'
record={'status':'PASS','action':'COST_ONLY_FIXED_FAILED_CASE20','qualificationSha256':sha(cbytes),'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceReview':{'reviewer':'Actual Hermes independent session','path':str(review),'sha256':sha(review.read_bytes()),'sessionId':usage['session_id'],'model':usage['model'],'provider':usage['provider'],'scope':'Independent source review; did not execute tests'},'leadVerification':{'sourceHashes':len(c['sources']),'qualifiedLogHashes':len(c['tests']),'operatorDryTests':5,'priorTests':177,'journalEvents':23,'journalUnchanged':True,'reviewedNativeAppend':True},'limits':['Cost-only fixed terminal evidence; no new capture, cap increase, paid retry or benchmark PASS','No human rubric/release approval is represented']}
with (root/'independent-review.json').open('x',encoding='utf-8')as f:json.dump(record,f,indent=2);f.write('\n')
print(json.dumps({'status':'PASS','qualificationSha256':sha(cbytes),'sourceReviewSha256':sha(review.read_bytes())}))
