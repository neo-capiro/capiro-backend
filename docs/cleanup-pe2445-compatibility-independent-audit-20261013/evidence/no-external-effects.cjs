const fail = () => { throw new Error('Audit host refuses network/child execution'); };
for (const key of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']) require('node:child_process')[key]=fail;
for(const mod of ['node:net','node:tls','node:http','node:https','node:dns']) { const obj=require(mod); for(const key of ['connect','createConnection','request','get','lookup','resolve','resolve4','resolve6']) if(typeof obj[key]==='function')obj[key]=fail; }
globalThis.fetch=fail;
