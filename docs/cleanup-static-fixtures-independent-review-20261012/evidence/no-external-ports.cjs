const denied = port => function () { throw new Error(`Inert static-contract runner refused ${port}`); };
for (const [module, methods] of [['node:net', ['connect', 'createConnection']], ['node:http', ['request', 'get']], ['node:https', ['request', 'get']], ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']], ['node:child_process', ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']]]) {
  const object = require(module);
  for (const method of methods) object[method] = denied(`${module}.${method}`);
}
require('node:net').Socket.prototype.connect = denied('Socket.connect');
global.fetch = denied('fetch');
