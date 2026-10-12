// Test-process safeguard only. Production sources/configuration are untouched.
// Source test transport must be mocked. Permit only TSX local UNIX IPC, never TCP/TLS/HTTP.
const { syncBuiltinESMExports } = require('node:module');
const refuse = () => { throw new Error('SOURCE_ONLY_CHECK_REFUSED_UNMOCKED_NETWORK'); };
const net = require('node:net');
const originalSocketConnect = net.Socket.prototype.connect;
function ipcOnlyConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const socketPath = typeof first === 'string' ? first : first && typeof first === 'object' ? first.path : null;
  if (typeof socketPath !== 'string' || !/^\/tmp\/tsx-\d+\/\d+\.pipe$/.test(socketPath)) return refuse();
  return originalSocketConnect.apply(this, args);
}
net.Socket.prototype.connect = ipcOnlyConnect;
const originalNetConnect = net.connect;
const originalCreateConnection = net.createConnection;
function ipcOnlyFactory(original, ...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const socketPath = typeof first === 'string' ? first : first && typeof first === 'object' ? first.path : null;
  if (typeof socketPath !== 'string' || !/^\/tmp\/tsx-\d+\/\d+\.pipe$/.test(socketPath)) return refuse();
  return original(...args);
}
net.connect = (...args) => ipcOnlyFactory(originalNetConnect, ...args);
net.createConnection = (...args) => ipcOnlyFactory(originalCreateConnection, ...args);
require('node:tls').connect = refuse;
for (const name of ['node:http', 'node:https']) {
  require(name).request = refuse;
  require(name).get = refuse;
}
globalThis.fetch = async () => { refuse(); };
syncBuiltinESMExports();
