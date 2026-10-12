require('./strict-source-read-refusal.cjs');
const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '../../../apps/api/src/clients/clients.service.ts');
const rawRead = fs.readFileSync;
const original = rawRead(target, 'utf8');
const mutations = {
  'tenant-unbound': ['WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${clientId}::uuid', 'WHERE id = ${clientId}::uuid'],
  'actor-instead-client': ['WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${clientId}::uuid', 'WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${ctx.userId}::uuid'],
  'share-instead-update': ['        FOR UPDATE\n', '        FOR SHARE\n'],
  'wrong-table': ['        SELECT id FROM clients\n', '        SELECT id FROM tenants\n'],
  'no-absence-guard': ["      if (!locked.length) throw new NotFoundException('Client not found');\n", ''],
  'grant-read-before-lock': ['      const locked = await tx.$queryRaw', '      await tx.clientMemoryAccess.findMany({ where: { tenantId: ctx.tenantId, clientId } });\n      const locked = await tx.$queryRaw'],
};
const mutation = process.env.LOCK_MUTATION;
const pair = mutations[mutation];
if (!pair || original.split(pair[0]).length !== 2) throw new Error('Expected one controlled lock-source mutation');
const changed = original.replace(pair[0], pair[1]);
fs.readFileSync = function (file, options) {
  if (typeof file === 'string' && path.resolve(file) === target) {
    return options === 'utf8' || options?.encoding === 'utf8' ? changed : Buffer.from(changed);
  }
  return rawRead.apply(this, arguments);
};
require('node:module').syncBuiltinESMExports();
