// Test-process safeguard only. Production sources/configuration are untouched.
// A source-only frontend suite must mock transport; real outgoing I/O throws.
const { syncBuiltinESMExports } = require('node:module');
const refuse = () => { throw new Error('SOURCE_ONLY_CHECK_REFUSED_UNMOCKED_NETWORK'); };
require('node:net').connect = refuse;
require('node:net').createConnection = refuse;
require('node:net').Socket.prototype.connect = refuse;
require('node:tls').connect = refuse;
for (const name of ['node:http', 'node:https']) {
  require(name).request = refuse;
  require(name).get = refuse;
}
globalThis.fetch = async () => { refuse(); };
syncBuiltinESMExports();
