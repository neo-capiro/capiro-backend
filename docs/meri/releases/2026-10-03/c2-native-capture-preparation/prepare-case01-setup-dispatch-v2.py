from pathlib import Path
import datetime, hashlib, json

out=Path('C:/dev/main/outputs/meri-c2-20261003')
original=out/'run-case01-native-setup.mjs'
source=original.read_text(encoding='utf-8')
old="import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';"
new="import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,mkdirSync,existsSync} from 'node:fs';"
assert source.count(old)==1;source=source.replace(old,new)
source=source.replace("import {fingerprint} from", "import {fingerprint,taskInput} from")
oldsave="const save=(name,v)=>writeFileSync(root+'/'+name,JSON.stringify(v,null,2)+'\\n',{flag:'wx'});"
newsave="const save=(name,v)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(v,null,2)+'\\n');fsyncSync(fd);}finally{closeSync(fd);}};"
assert source.count(oldsave)==1;source=source.replace(oldsave,newsave)
oldtemplate="const definition=read(parent+'/corpus-read-definition-input.json');"
newtemplate="const templateBytes=readFileSync(parent+'/corpus-read-definition-input.json');\nassert.equal(hash(templateBytes),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478','Reviewed task template drift');\nconst definition=JSON.parse(templateBytes);"
assert source.count(oldtemplate)==1;source=source.replace(oldtemplate,newtemplate)
oldregister="save('definition-registered.json',{at:new Date().toISOString(),taskDefinition:td});"
newregister="""save('definition-registered.json',{at:new Date().toISOString(),taskDefinition:td});
  const registered=aws(['ecs','describe-task-definition','--task-definition',td,'--include','TAGS']);
  assert.equal(registered.taskDefinition.status,'ACTIVE');
  const registeredHash=fingerprint(taskInput({...registered.taskDefinition,tags:registered.tags}));
  assert.equal(registeredHash,fingerprint(taskInput(definition)),'Registered task input drift');
  save('definition-readback.json',{at:new Date().toISOString(),taskDefinition:td,taskInputSha256:registeredHash,templateBytesSha256:hash(templateBytes)});"""
assert source.count(oldregister)==1;source=source.replace(oldregister,newregister)
dest=out/'run-case01-native-setup-v2.mjs'
with dest.open('x',encoding='utf-8',newline='\n')as f:f.write(source)
record={'version':2,'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'PREPARED_NOT_EXECUTED_PENDING_REVIEW','originalPath':original.name,'originalSha256':hashlib.sha256(original.read_bytes()).hexdigest(),'replacementPath':dest.name,'replacementSha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'resolvedReviewFindings':['fsync every exclusive host record/input before subsequent cloud mutation','pin exact reviewed task template bytes, then independently describe and fingerprint registered task before RunTask'],'innerScriptUnchanged':'632d00e47ec63fb8c0b49cfa0d166760bd16abbf5ded9b572c0a9cf235f9899d','serviceMutations':0,'setupExecutions':0,'journalMutations':0,'providerCalls':0}
with (out/'case01-setup-dispatch-v2-preparation.json').open('x',encoding='utf-8',newline='\n')as f:json.dump(record,f,indent=2);f.write('\n')
print(json.dumps(record,indent=2))
