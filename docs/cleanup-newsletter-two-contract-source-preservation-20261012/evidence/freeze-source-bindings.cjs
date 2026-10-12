// Read-only Git/source equality, then writes only this packet's receipts.
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root='docs/cleanup-newsletter-two-contract-source-preservation-20261012/';
const source='a247f7a02a9b94d95e9ee5a516b396202aea994b',base='7ea444c74a5637577aa0eb3cb99cb420b5f8223e',publication='bcad60272fa300383f117f3a08a554e9e070e85b';
const git=(...args)=>cp.execFileSync('git',args,{encoding:'utf8',maxBuffer:8000000}).trim();
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const original=JSON.parse(fs.readFileSync(root+'evidence/ORIGINAL-SOURCE-MANIFEST.json','utf8'));
const paths=git('diff-tree','--no-commit-id','--name-only','-r',source).split('\n');assert.equal(paths.length,76);
assert.equal(git('diff','--name-only',source,'HEAD','--','.',':!docs'),'');
assert.equal(git('diff','--name-only',base,publication,'--','.',':!docs'),'');
assert.equal(git('rev-list','--count',publication+'..HEAD')==='0',false);
cp.execFileSync('git',['merge-base','--is-ancestor',publication,'HEAD']);
const entries=paths.map(path=>{
 const data=fs.readFileSync(path),blob=git('rev-parse',source+':'+path),current=git('hash-object',path);assert.equal(current,blob);
 const orig=original.entries.find(x=>x.path===path);if(orig){assert.equal(blob,orig.Cblob);assert.equal(hash(data),orig.sha256);}
 return{path,kind:orig?.kind??'canonical-additive-integration',sourceBlob:blob,currentBlob:current,bytes:data.length,sha256:hash(data),originalCblob:orig?.Cblob??null,originalWblob:orig?.Wblob??null};
});
assert.equal(entries.filter(x=>x.originalCblob).length,58);
const receipt={sourceHead:source,sourceTree:git('rev-parse',source+'^{tree}'),base,publicationHead:publication,publicationTree:git('rev-parse',publication+'^{tree}'),mergedHead:git('rev-parse','HEAD'),mergedTree:git('rev-parse','HEAD^{tree}'),mergeParents:git('show','-s','--format=%P','HEAD').split(' '),wholeNonDocSourceDelta:[],overlayCount:76,originalCount:58,canonicalIntegrationCount:18,entries};
fs.writeFileSync(root+'SOURCE-BINDINGS.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({result:'PASS complete non-doc source equal frozen a247; actual publication ancestry retained',sourceHead:source,mergedHead:receipt.mergedHead,mergedTree:receipt.mergedTree,overlay:76,original:58,canonicalIntegration:18},null,2));
