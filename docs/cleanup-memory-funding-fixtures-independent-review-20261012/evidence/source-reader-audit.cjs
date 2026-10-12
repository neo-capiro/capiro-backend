const fs=require('node:fs'),path=require('node:path');
const root=process.cwd(),packet=path.join(root,'docs/cleanup-memory-funding-fixtures-independent-review-20261012');
const baseline=JSON.parse(fs.readFileSync(path.join(packet,'BASELINE-IDENTITIES.json'),'utf8'));
const block=new Set(baseline.identities.filter(r=>r.path.startsWith('apps/web/')).map(r=>path.join(root,r.path)));
const original=fs.readFileSync;const reads=[],refused=[];
fs.readFileSync=function(file,...args){
 const absolute=typeof file==='string'?path.resolve(file):null;
 if(absolute&&block.has(absolute)){refused.push(absolute);const error=new Error('INERT_REVIEW_WEB_SOURCE_UNAVAILABLE '+absolute);error.code='ENOENT';throw error;}
 if(absolute&&absolute.includes('/__fixtures__/legacy-ui-contracts/'))reads.push(absolute);
 return original.call(this,file,...args);
};
process.on('exit',()=>{const output=process.env.INERT_READER_RECEIPT;if(output)fs.writeFileSync(output,JSON.stringify({exactSevenWebSourcesBlocked:[...block],refused,fixtureReads:reads,guardScope:'Only owned test process readFileSync; no files deleted/changed or application policy changed'},null,2)+'\n');});
