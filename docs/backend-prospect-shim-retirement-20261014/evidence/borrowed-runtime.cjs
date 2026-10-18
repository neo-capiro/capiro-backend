const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const q=__dirname, repo='/workspace/capiro-backend-prospect-shim-retirement-20261014',ref='85d582c35a9971538a709225ebaf0e0a762073c6';
const rows=[];
for(const name of ['@capiro/shared','@capiro/meriv2-core']){
 try{
  const resolved=require.resolve(name,{paths:[path.join(q,'overlay/apps/api')]});const source=fs.readFileSync(resolved);let directory=path.dirname(resolved),pkg=null;
  while(directory!==path.dirname(directory)){const candidate=path.join(directory,'package.json');if(fs.existsSync(candidate)){const value=JSON.parse(fs.readFileSync(candidate,'utf8'));if(value.name===name){pkg={path:candidate,name:value.name,version:value.version,sha256:crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')};break}}directory=path.dirname(directory)}
  const relative=resolved.startsWith('/workspace/capirov2/')?resolved.slice('/workspace/capirov2/'.length):null;
  const frozen=relative?cp.spawnSync('git',['show',`${ref}:${relative}`],{cwd:repo}):null;
  rows.push({name,resolved,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),bytes:source.length,package:pkg,frozenPath:relative,topLevelSourceMatchesFrozenGit:Boolean(frozen&&frozen.status===0&&frozen.stdout.equals(source)),transitiveRuntimeClosureQualified:false});
 }catch(error){rows.push({name,resolutionError:error.message,transitiveRuntimeClosureQualified:false})}
}
fs.writeFileSync(path.join(q,'BORROWED-RUNTIME.json'),JSON.stringify({scope:'Borrowed cached workspace runtime package resolution/top-level hashes only; not a complete loaded-module manifest or exact frozen transitive runtime source qualification. Tests passed against these cached dependencies, with 11 exact overlay inputs. No package execution by this inspector.',qualifiedWholeRuntimeClosure:false,packages:rows},null,2)+'\n');
console.log(JSON.stringify(rows));
