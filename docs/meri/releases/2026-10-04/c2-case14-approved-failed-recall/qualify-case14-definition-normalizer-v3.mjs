import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { taskInput } from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const source=readFileSync(root+'/run-case14-native-execute-v3.mjs','utf8');
const start=source.indexOf('const normalizeDefinition=value=>{');
const end=source.indexOf('\nconst exactFamilyInventory',start);
assert.ok(start>0 && end>start);
const normalize=new Function('taskInput', source.slice(start,end)+'\nreturn normalizeDefinition;')(taskInput);
const input=JSON.parse(readFileSync(root+'/case14-native-execute-v2/definition-input.private.json'));
const actual=JSON.parse(readFileSync(root+'/case14-native-execute-v2/registered-definition-readback.private.json'));
const readback={...actual.taskDefinition,tags:actual.tags};
assert.deepEqual(normalize(structuredClone(input)),normalize(structuredClone(readback)));
const mutations={
  'nonzero cpu': x=>x.containerDefinitions[0].cpu=1,
  'nonempty volumes': x=>x.volumes=[{name:'unexpected'}],
  'nonempty mounts': x=>x.containerDefinitions[0].mountPoints=[{sourceVolume:'unexpected',containerPath:'/tmp'}],
  'source environment': x=>x.containerDefinitions[0].environment.find(e=>e.name==='RELEASE_SHA').value='wrong',
  'ownership marker': x=>x.tags.find(e=>e.key==='MeriC2RegistrationOwner').value='wrong',
  'task role': x=>x.taskRoleArn='unexpected',
  'image': x=>x.containerDefinitions[0].image='unexpected',
};
for(const change of Object.values(mutations)){
  const copy=structuredClone(readback);change(copy);
  assert.notDeepEqual(normalize(copy),normalize(structuredClone(input)));
}
const cleanup=JSON.parse(readFileSync(root+'/case14-native-execute-v2/cleanup.json'));
assert.equal(cleanup.taskArn,null);assert.equal(cleanup.status,'INACTIVE');assert.equal(cleanup.cleanupComplete,true);
const proof={at:new Date().toISOString(),status:'PASS',operatorSha256:createHash('sha256').update(source).digest('hex'),actualAwsDefaultsMatch:true,negativeCases:Object.keys(mutations),previousAttemptNoTask:true,previousDefinitionInactive:true,cloudActions:0};
writeFileSync(root+'/case14-definition-normalizer-v3-qualification.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(proof));
