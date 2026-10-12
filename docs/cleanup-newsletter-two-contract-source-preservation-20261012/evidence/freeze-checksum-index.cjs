// Check only this packet and frozen source files. No runtime application evaluation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root='docs/cleanup-newsletter-two-contract-source-preservation-20261012';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);assert(!e.isSymbolicLink());return e.isDirectory()?files(p):[p];});}
const packet=files(root).filter(p=>p!==root+'/SHA256-INDEX.json').sort().map(p=>{const bytes=fs.readFileSync(p);return{path:p,bytes:bytes.length,sha256:hash(bytes)};});
const binding=JSON.parse(fs.readFileSync(root+'/SOURCE-BINDINGS.json','utf8'));
for(const entry of binding.entries)assert.equal(hash(fs.readFileSync(entry.path)),entry.sha256);
fs.writeFileSync(root+'/SHA256-INDEX.json',JSON.stringify({sourceHead:binding.sourceHead,sourceTree:binding.sourceTree,actualPublicationMergeHead:binding.mergedHead,scope:'all own packet files except self plus76 frozen source files; generated/cache/dependency links excluded',packetFiles:packet.length,sourceFiles:binding.entries.length,packet,source:binding.entries.map(({path,bytes,sha256,sourceBlob})=>({path,bytes,sha256,sourceBlob}))},null,2)+'\n');
console.log(JSON.stringify({result:'PASS',packetFiles:packet.length,sourceFiles:binding.entries.length}));
