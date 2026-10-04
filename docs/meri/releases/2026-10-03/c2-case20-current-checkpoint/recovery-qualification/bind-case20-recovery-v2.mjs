import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root='C:/dev/main/outputs/meri-c2-20261003';
const repo='C:/dev/main/meri-c1-20261002';
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/u,''));
const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
assert.equal(git('status','--porcelain'),'');
const commit=git('rev-parse','HEAD');
assert.equal(git('rev-parse','HEAD^'),'af7aa8aff4777a2d4809e882c2b797fbb2cd51a2');
const pins=[
 ['case20-presubmission-recovery-v1/checkpoint.json','58ef5990df45131ed040f2a411e73240362362b7dee7ba04b81436649b2d5376'],
 ['controlled-read-browser-readiness-v1/checkpoint.json','ecd68b3c56e16bf27831357d4530ff54329ff067ebf9cee3d7b38bf64db7dd59'],
 ['case20-recovery-independent-review-v1.json','287dbe4e52e40fca9105760b5f713a34c65bb2ce290de7e5bb5444effab06cc3'],
 ['controlled-read-browser-readiness-v1/independent-review.json','b21393e4bebada5ec2ba78147cb286d13449a91eca484394ca65c65ee7918fba'],
 ['run-case20-native-recovery-v2.mjs','c7bdbacd9f5cfef151c5d950d0e34c486dd7c795ccdb61c6dcd2e26418ecb2e8'],
 ['case20-live-scope-v1.json','ff11e6de4f6f89ed4314dda96a11bec7ccf724dc35d0520fdbefe33155266e0c']
];
const files=pins.map(([path,sha256])=>({path:root+'/'+path,sha256}));
const authority=read(root+'/case20-presubmission-recovery-v1/checkpoint.json');
const readiness=read(root+'/controlled-read-browser-readiness-v1/checkpoint.json');
for(const f of authority.files) files.push({path:f.path,sha256:f.sha256});
for(const f of readiness.sourceMirrors) files.push({path:f.sourcePath,sha256:f.sha256});
for(const f of files) assert.equal(hash(readFileSync(f.path)),f.sha256,f.path);
for(const f of [...authority.files,...readiness.sourceMirrors]){
 const relative=f.relativePath??f.path;
 assert.equal(hash(execFileSync('git',['show',commit+':'+relative],{cwd:repo,windowsHide:true})),f.sha256);
}
const reviewPath=root+'/case20-native-recovery-v2-reviewed-input.json';
const review={schemaVersion:1,status:'REVIEWED_CASE20_PRESUBMISSION_CONTINUATION',operatorCommit:commit,files,
 captureRunId:'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b',conversationId:'db0e01ac-60a1-4e3c-b8ba-66748d087a2e',
 reservationId:'7ea73cdc-526e-4b31-8c28-b0636ea8d2ae',ceilingMicros:15000000,preservePriorClaim:true,
 createConversation:false,newReserve:false,maximumNewTurns:1,automaticRetry:false,recordedAt:new Date().toISOString()};
writeFileSync(reviewPath,JSON.stringify(review,null,2)+'\n',{flag:'wx'});
const launcher=readFileSync(root+'/launch-case01-native-recovery-v1-once.mjs','utf8')
 .replaceAll('Case01','Case20').replaceAll('case01','case20')
 .replaceAll('native-recovery-v1','native-recovery-v2')
 .replaceAll('bd35c0f4-1604-4371-b7e9-a1338369e53f',review.captureRunId)
 .replace('7601f4bdd2c5b0559e0eb7a24f5036e921bcd3b0b88f2ea23fd9bf7bcefd333d',hash(readFileSync(reviewPath)))
 .replace('678e3108726a273afe0af7343060d6809518f9497282c1c8599fbee8bb13687a','c7bdbacd9f5cfef151c5d950d0e34c486dd7c795ccdb61c6dcd2e26418ecb2e8')
 .replace('7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60','d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b');
const launcherPath=root+'/launch-case20-native-recovery-v2-once.mjs';
assert.equal(existsSync(root+'/case20-native-recovery-v2-'+review.captureRunId),false);
assert.equal(existsSync(root+'/case20-presubmission-recovery-claim-'+review.captureRunId+'.json'),false);
assert.equal(hash(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),'d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b');
writeFileSync(launcherPath,launcher,{flag:'wx'});
console.log(JSON.stringify({commit,reviewPath,reviewSha256:hash(readFileSync(reviewPath)),launcherPath,launcherSha256:hash(readFileSync(launcherPath)),files:files.length}));
