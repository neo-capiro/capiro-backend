// Source-only qualification: all outbound/provider/native connection attempts fail.
const deny = () => { throw new Error('Source-only network fence'); };
const originalConnect = require('node:net').Socket.prototype.connect;
require('node:net').Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : { host: args[1] };
  const host = options.host ?? options.hostname;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(host)) return deny();
  return originalConnect.apply(this, args);
};
require('node:tls').connect = deny;

require('node:https').request = deny;
global.fetch = deny;
