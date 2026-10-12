import assert from 'node:assert/strict';
import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const config=JSON.parse(readFileSync('scripts/registry-ownership.json','utf8')),sources=new Map();
function walk(dir){for(const ent of readdirSync(dir,{withFileTypes:true})){const file=dir+'/'+ent.name;if(ent.isDirectory())walk(file);else if(ent.isFile()&&/\.(?:ts|tsx|mts|cts)$/.test(file)&&!/(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/.test(file))sources.set(file,readFileSync(file,'utf8'));}}
for(const root of new Set(config.profiles.flatMap(p=>p.roots)))walk(root);
assert.equal(inspectRegistryOwnership(sources,config).errors.length,0);
const results=[];
for(const [label,source] of [
 ['erased as-expression require alias',"const load=require as typeof require;load('./external/tango/tango-rest-page.js');"],
 ['deep static canonical declaration',`const extra={[${'('.repeat(140)}'asCount'${')'.repeat(140)}](){return 1;}};`],
 ['deep static owner module',`import(${'('.repeat(140)}'./external/tango/tango-rest-page.js'${')'.repeat(140)});`],
]){const files=new Map(sources);files.set('apps/api/src/review-parser-extra.ts',source);const result=inspectRegistryOwnership(files,config);results.push({label,source,rejected:result.errors.length>0,errors:result.errors});}
writeFileSync(new URL('whole-map-parser-9a23.json',import.meta.url),JSON.stringify({source:'9a23cd7273028e97581b0605d321e69d0185d536',baselineFiles:sources.size,results,sourceMutantsExecuted:false},null,2)+'\n');
console.log(JSON.stringify({baselineFiles:sources.size,results,sourceMutantsExecuted:false},null,2));
