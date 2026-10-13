const fs = require('node:fs');
const forbidden = p => /[/\\]engagement[/\\]engagement\.service\.ts$/.test(String(p));
for (const method of ['readFileSync', 'readFile']) {
 const original = fs[method];
 fs[method] = function(p, ...args) { if (forbidden(p)) throw new Error('Protected reporting source read refused'); return original.call(this, p, ...args); };
}
const originalAsync = fs.promises.readFile;
fs.promises.readFile = function(p, ...args) { if (forbidden(p)) throw new Error('Protected reporting source read refused'); return originalAsync.call(this, p, ...args); };
const refuse = () => { throw new Error('Outbound/native process action refused in bounded receiving tests'); };
for (const name of ['http', 'https']) { const owner = require('node:' + name); owner.request = refuse; owner.get = refuse; }
require('node:net').connect = refuse; require('node:net').createConnection = refuse; require('node:tls').connect = refuse;
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[key] = refuse;
global.fetch = refuse;
