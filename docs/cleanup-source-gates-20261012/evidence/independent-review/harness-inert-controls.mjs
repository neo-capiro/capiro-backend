import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { types } from 'node:util';
import { createHash } from 'node:crypto';

const file = new URL('./reviewed-preload-hardened.cjs', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const cases = [
  ['net TCP number', 'net.connect(443, "synthetic.invalid")', false],
  ['Socket TCP object', '(new net.Socket()).connect({port:443,host:"synthetic.invalid"})', false],
  ['mixed IPC/TCP', 'net.connect({path:"/tmp/tsx-123/456.pipe",port:443,host:"synthetic.invalid"})', false],
  ['unknown option', 'net.createConnection({path:"/tmp/tsx-123/456.pipe",timeout:100})', false],
  ['symbol option', 'net.connect({path:"/tmp/tsx-123/456.pipe",[Symbol("extra")]:true})', false],
  ['non-TSX UNIX', 'net.connect("/tmp/unrelated.sock")', false],
  ['relative path', 'net.connect("../tmp/tsx-123/456.pipe")', false],
  ['traversal', 'net.connect("/tmp/tsx-123/../456.pipe")', false],
  ['path suffix', 'net.connect("/tmp/tsx-123/456.pipe/extra")', false],
  ['boxed string', 'net.connect(new String("/tmp/tsx-123/456.pipe"))', false],
  ['nonplain prototype', 'net.connect(Object.assign(Object.create({}),{path:"/tmp/tsx-123/456.pipe"}))', false],
  ['getter path', 'net.connect({get path(){probe.getterReads++;return "/tmp/tsx-123/456.pipe";}})', false],
  ['normalized array getter', 'const args=[];Object.defineProperty(args,"0",{get(){probe.getterReads++;return {path:"/tmp/tsx-123/456.pipe"};}});net.connect(args)', false],
  ['proxy object', 'net.connect(new Proxy({path:"/tmp/tsx-123/456.pipe"},{get(...args){probe.proxyReads++;return Reflect.get(...args);}}))', false],
  ['proxy array', 'net.connect(new Proxy([{path:"/tmp/tsx-123/456.pipe"},null],{get(...args){probe.proxyReads++;return Reflect.get(...args);}}))', false],
  ['revoked proxy', 'const p=Proxy.revocable({path:"/tmp/tsx-123/456.pipe"},{});p.revoke();net.connect(p.proxy)', false],
  ['TLS', 'require("node:tls").connect({port:443})', false],
  ['HTTP request', 'require("node:http").request("http://synthetic.invalid")', false],
  ['HTTP get', 'require("node:http").get("http://synthetic.invalid")', false],
  ['HTTPS request', 'require("node:https").request("https://synthetic.invalid")', false],
  ['HTTPS get', 'require("node:https").get("https://synthetic.invalid")', false],
  ['fetch', 'await fetch("https://synthetic.invalid")', false],
  ['valid path string', 'net.connect("/tmp/tsx-123/456.pipe")', true],
  ['valid plain options', 'const input={path:"/tmp/tsx-123/456.pipe"};probe.original=input;net.createConnection(input)', true],
  ['valid normalized args', 'const input={path:"/tmp/tsx-123/456.pipe"};probe.original=input;(new net.Socket()).connect([input,()=>{}])', true],
  ['valid null-prototype options', 'const input=Object.assign(Object.create(null),{path:"/tmp/tsx-123/456.pipe"});probe.original=input;net.connect(input,null)', true],
  ['valid callback', 'net.connect("/tmp/tsx-123/456.pipe",()=>{})', true],
];
const results = [];
for (const [name, expression, allowed] of cases) {
  const probe = { delegated: [], getterReads: 0, proxyReads: 0, original: null };
  const net = { Socket: function Socket() {} };
  net.Socket.prototype.connect = function originalConnect(options, callback) {
    probe.delegated.push({ keys: Reflect.ownKeys(options), path: options.path,
      frozen: Object.isFrozen(options), originalForwarded: options === probe.original,
      callback: callback == null ? null : typeof callback });
    return this;
  };
  net.connect = (options, callback) => new net.Socket().connect(options, callback);
  net.createConnection = (options, callback) => new net.Socket().connect(options, callback);
  const modules = { 'node:net': net, 'node:util': { types },
    'node:tls': { connect() { throw Error('Forbidden original TLS'); } },
    'node:http': { request() { throw Error('Forbidden original HTTP'); }, get() { throw Error('Forbidden original HTTP'); } },
    'node:https': { request() { throw Error('Forbidden original HTTPS'); }, get() { throw Error('Forbidden original HTTPS'); } },
    'node:module': { syncBuiltinESMExports() {} } };
  const context = vm.createContext({ probe, require(name) { if (!(name in modules)) throw Error('Unexpected import'); return modules[name]; } });
  vm.runInContext(source, context, { timeout: 1000 });
  let error = null;
  try { await vm.runInContext(`(async()=>{${expression}})()`, context, { timeout: 1000 }); }
  catch (caught) { error = String(caught.message); }
  assert.equal(probe.getterReads, 0, `${name}: accessor executed`);
  assert.equal(probe.proxyReads, 0, `${name}: proxy trap executed`);
  if (allowed) {
    assert.equal(error, null, name);
    assert.equal(probe.delegated.length, 1, name);
    const actual = probe.delegated[0];
    assert.deepEqual(Array.from(actual.keys), ['path'], name);
    assert.equal(actual.path, '/tmp/tsx-123/456.pipe', name);
    assert.equal(actual.frozen, true, name);
    assert.equal(actual.originalForwarded, false, name);
  } else {
    assert.ok(error, `${name}: missing refusal`);
    assert.equal(probe.delegated.length, 0, `${name}: reached original transport`);
    assert.ok(error.includes('SOURCE_ONLY_CHECK_REFUSED_UNMOCKED_NETWORK') || name === 'revoked proxy', name);
  }
  results.push({ name, expected: allowed ? 'immutable TSX IPC delegation' : 'refused before original transport', passed: true });
}
console.log(JSON.stringify({ harness: file, harnessSHA256: createHash('sha256').update(source).digest('hex'),
  tests: results.length, passed: results.length, results,
  actualSocketsDatabaseProviderCloudExecution: false,
  limit: 'Inert controls over named Node transport API preload; not OS/syscall containment or native release acceptance.' }, null, 2));
