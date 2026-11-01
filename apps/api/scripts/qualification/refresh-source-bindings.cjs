const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n');
const contractPath='docs/runtime-production-closure-20261014/RUNTIME-CLOSURE-CONTRACT.json';
const helperPath='apps/api/scripts/qualification/runtime-closure-contract.cjs';
const contract=JSON.parse(read(contractPath));
for(const file of Object.keys(contract.inputSHA256)) contract.inputSHA256[file]=hash(read(file));
const output=JSON.stringify(contract,null,2)+'\n';
let helper=read(helperPath).replace(/const CONTRACT_SHA256 = '[a-f0-9]{64}';/, "const CONTRACT_SHA256 = '"+hash(output)+"';");
const schema=read('apps/api/prisma/schema.prisma');
const pins=Object.fromEntries(Object.entries({arm64:'linux-musl-arm64-openssl-3.0.x',x64:'linux-musl-openssl-3.0.x'}).map(([arch,target])=>[arch,hash(schema.replace('"linux-arm64-openssl-3.0.x"','"'+target+'"'))]));
helper=helper.replace(/const IMAGE_LOCAL_PRISMA_SCHEMA_SHA256 = Object.freeze\(\{[\s\S]*?\}\);/,
"const IMAGE_LOCAL_PRISMA_SCHEMA_SHA256 = Object.freeze({\n  arm64: '"+pins.arm64+"',\n  x64: '"+pins.x64+"',\n});");
if(process.argv[2]==='--write'){fs.writeFileSync(path.join(root,contractPath),output);fs.writeFileSync(path.join(root,helperPath),helper);}
else if(output!==read(contractPath)||helper!==read(helperPath))throw Error('Source bindings changed; run refresh-source-bindings.cjs --write. Dependency graph changes require regenerating the graph separately.');
console.log('Source package and image-local Prisma schema bindings match; no image qualification is claimed.');

