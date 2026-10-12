import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const file = new URL('./reviewed-preload-initial.cjs', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const delegated = [];
const net = {
  Socket: function Socket() {},
};
net.Socket.prototype.connect = function originalConnect(options) {
  // Model the installed Node implementation's later read of options.path.
  // This is an inert stand-in; no socket, DNS, process or provider is invoked.
  const socketPath = options.path;
  delegated.push({ transport: socketPath ? 'AF_UNIX' : 'TCP', path: socketPath ?? null, port: options.port ?? null });
  return this;
};
net.connect = options => new net.Socket().connect(options);
net.createConnection = options => new net.Socket().connect(options);
const modules = { 'node:net': net, 'node:tls': { connect() {} }, 'node:http': { request() {}, get() {} }, 'node:https': { request() {}, get() {} }, 'node:module': { syncBuiltinESMExports() {} } };
const context = { require(name) { if (!(name in modules)) throw Error('Unexpected import'); return modules[name]; } };
vm.runInNewContext(source, context, { timeout: 1000 });
let reads = 0;
const options = { port: 443, host: 'synthetic.invalid' };
Object.defineProperty(options, 'path', { get() { return ++reads <= 2 ? '/tmp/tsx-123/456.pipe' : undefined; } });
let thrown = null;
try { net.connect(options); } catch (error) { thrown = String(error.message); }
console.log(JSON.stringify({ harness: file, harnessSHA256: createHash('sha256').update(source).digest('hex'),
  optionsPathReads: reads, delegated, thrown,
  finding: delegated.some(row => row.transport === 'TCP') ? 'guard forwarded mutable/getter options; later delegate sees TCP shape' : 'guard refused mutable/getter options',
  actualNetworkDatabaseProviderExecution: false,
}, null, 2));
