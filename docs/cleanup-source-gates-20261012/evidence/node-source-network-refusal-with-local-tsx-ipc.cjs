// Diagnostic test process only; no production/release configuration change.
// Bind TSX local UNIX IPC to immutable path-only arguments. Never forward input.
const { syncBuiltinESMExports } = require('node:module');
const { isProxy } = require('node:util').types;
const refuse = () => { throw new Error('SOURCE_ONLY_CHECK_REFUSED_UNMOCKED_NETWORK'); };
function boundIpc(args) {
  let values = args;
  if (Array.isArray(args[0])) {
    if (isProxy(args[0])) return refuse();
    values = [0, 1].map((index) => {
      const descriptor = Object.getOwnPropertyDescriptor(args[0], String(index));
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return refuse();
      return descriptor?.value;
    });
  }
  if (values.length > 2 || (values[1] != null && typeof values[1] !== 'function')) return refuse();
  const first = values[0];
  let socketPath;
  if (typeof first === 'string') socketPath = first;
  else {
    if (!first || typeof first !== 'object' || isProxy(first)) return refuse();
    const prototype = Object.getPrototypeOf(first);
    if (prototype !== Object.prototype && prototype !== null) return refuse();
    if (Reflect.ownKeys(first).length !== 1 || !Object.hasOwn(first, 'path')) return refuse();
    const descriptor = Object.getOwnPropertyDescriptor(first, 'path');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return refuse();
    socketPath = descriptor.value;
  }
  if (typeof socketPath !== 'string' || !/^\/tmp\/tsx-\d+\/\d+\.pipe$/.test(socketPath)) return refuse();
  return [Object.freeze({ path: socketPath }), values[1]];
}
const net = require('node:net');
const originalSocketConnect = net.Socket.prototype.connect;
const originalNetConnect = net.connect;
const originalCreateConnection = net.createConnection;
net.Socket.prototype.connect = function (...args) {
  return originalSocketConnect.apply(this, boundIpc(args));
};
net.connect = (...args) => originalNetConnect(...boundIpc(args));
net.createConnection = (...args) => originalCreateConnection(...boundIpc(args));
require('node:tls').connect = refuse;
for (const name of ['node:http', 'node:https']) {
  require(name).request = refuse;
  require(name).get = refuse;
}
globalThis.fetch = async () => { refuse(); };
syncBuiltinESMExports();
