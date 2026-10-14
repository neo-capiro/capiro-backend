const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const names=['tracker-watchlist-compiled','tracker-watchlist-input','tracker-watchlist-preferences','tracker-watchlist-read','tracker-watchlist-reconcile-finish','tracker-watchlist-reconcile-head','tracker-watchlist-reconcile-topics','tracker-watchlist-write','tracker-watchlist.contracts','tracker-watchlist.service'];
const artifacts=[];
for(const name of names){
 const js=path.join(root,'apps/intel-api/dist/tracker',name+'.js');
 const result=cp.spawnSync(process.execPath,['--check',js],{encoding:'utf8',env:process.env});
 if(result.status!==0)throw new Error('Emitted syntax check failed: '+name);
 for(const suffix of ['.js','.js.map','.d.ts','.d.ts.map']){
  const file=path.join(root,'apps/intel-api/dist/tracker',name+suffix);const data=fs.readFileSync(file);
  artifacts.push({path:path.relative(root,file),bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});
 }
}
fs.writeFileSync(path.join(__dirname,'evidence/emitted-watchlist-artifacts.json'),JSON.stringify({syntax_checks:10,artifacts,bootstrap_or_native_execution:false},null,2)+'\n');
console.log(JSON.stringify({syntax_checks:10,artifacts:artifacts.length,result:'PASS'}));
