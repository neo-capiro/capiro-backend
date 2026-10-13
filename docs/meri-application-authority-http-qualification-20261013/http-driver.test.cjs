'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validatePrivateConfig,IDS,ROUTES} = require('./http-driver.cjs');
const valid = {
  sourceHead:'bbb38185058fdc64c204da723943aee055b3dad3',
  approvedOwnedDatabase:true,databaseName:'capiro_auth_http_20261013_4966f869fa',
  databaseOid:16917,databaseComment:'owned /root authority HTTP fixture at bbb38185058fdc64c204da723943aee055b3dad3',
  systemIdentifier:'7695590366852821031',
  connectionUrl:'postgresql://capiro@127.0.0.1:5432/capiro_auth_http_20261013_4966f869fa?schema=public&connection_limit=1',
};
test('approved owned target syntax accepted without connection',()=>assert.equal(validatePrivateConfig(valid).hostname,'127.0.0.1'));
for (const [name,key,value] of [
  ['wrong source','sourceHead','foreign'],['approval missing','approvedOwnedDatabase',false],
  ['ordinary database','databaseName','capiro'],['other cluster','systemIdentifier','7695922344929406966'],
  ['OID invalid','databaseOid',0],['ownership comment missing','databaseComment',null],
  ['foreign network','connectionUrl','postgresql://synthetic@foreign.invalid:5432/capiro_auth_http_20261013_4966f869fa'],
  ['wrong database path','connectionUrl','postgresql://synthetic@127.0.0.1:5432/capiro'],
  ['foreign schema','connectionUrl',valid.connectionUrl.replace('schema=public','schema=foreign')],
  ['pool widened','connectionUrl',valid.connectionUrl.replace('connection_limit=1','connection_limit=5')],
  ['nonPostgres protocol','connectionUrl','https://127.0.0.1/capiro_auth_http_20261013_4966f869fa'],
]) test(`target refusal: ${name}`,()=>assert.throws(()=>validatePrivateConfig({...valid,[key]:value})));
test('fixed two authority routes use actual clio prefix',()=>assert.deepEqual(ROUTES,{identity:'/api/clio/application-authority/identity',context:'/api/clio/application-authority/context'}));
test('all synthetic fixture identifiers are unique lower-case UUIDs',()=>{
  assert.equal(new Set(Object.values(IDS)).size,Object.values(IDS).length);
  for(const id of Object.values(IDS)) assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
