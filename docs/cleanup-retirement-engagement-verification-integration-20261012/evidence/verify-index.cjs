const fs=require('node:fs'),crypto=require('node:crypto');
const root='docs/cleanup-retirement-engagement-verification-integration-20261012';
const index=JSON.parse(fs.readFileSync(root+'/SHA256-INDEX.json','utf8'));
const failures=[];
for(const e of [...index.packet,...index.sourceEntries]){const bytes=fs.readFileSync(e.path),actual=crypto.createHash('sha256').update(bytes).digest('hex');if(bytes.length!==e.bytes||actual!==e.sha256)failures.push({path:e.path,expectedBytes:e.bytes,actualBytes:bytes.length,expectedSha256:e.sha256,actualSha256:actual});}
console.log(JSON.stringify({result:failures.length?'RED':'PASS',packet:index.packet.length,source:index.sourceEntries.length,failures},null,2));
process.exitCode=failures.length?1:0;
